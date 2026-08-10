/**
 * Live provider health check (EventBridge: weekday pre / regular / after ET;
 * also post-deploy). The only Lambda that makes real Massive/Finnhub round-trips —
 * local tests always stub vendors. Telegram probe is read-only (getMe/getWebhookInfo,
 * never sends). Throws on any failure so LiveProviderCheckFunctionErrorAlarm pages
 * via SNS.
 */
import type { Context } from "aws-lambda";
import { HttpError } from "grammy";
import { fetchEarnings } from "../../lib/asset-events/earnings";
import { MIN_PLAUSIBLE_ACTIVE_UNIVERSE } from "../../lib/assets/constants";
import { fetchTickerDetail } from "../../lib/assets/reference/ticker-detail";
import { fetchActiveTickers } from "../../lib/assets/reference/universe";
import { createLogger, type Logger } from "../../lib/logging";
import { RELEASE_ID } from "../../lib/logging/release-id";
import { runLambda } from "../../lib/logging/request-context";
import { fetchDailyCloses, fetchPrevClose } from "../../lib/market-data/bars";
import { fetchAssetPricesWithSessionState } from "../../lib/market-data/prices";
import { getCurrentMarketSession } from "../../lib/market-data/session";
import { buildCandlestickSvg } from "../../lib/messaging/telegram/candlestick";
import { checkTelegramLive } from "../../lib/messaging/telegram/health";
import { renderChartPng } from "../../lib/messaging/telegram/render-png";
import { createTelegramBot, readTelegramBotToken } from "../../lib/messaging/telegram/sender";
import { assertStructuredBinaryCard } from "../../lib/prediction-markets/binary";
import { CURATED_PREDICTION_MARKETS } from "../../lib/prediction-markets/catalog";
import { fetchCuratedPredictionMarketCards } from "../../lib/prediction-markets/fetch";
import type { ActiveMarketSession, IntradayCandle, MarketSession } from "../../lib/types";
import { isRecord } from "../../lib/types";
import { kalshiFetch } from "../../lib/vendors/kalshi";
import { polymarketFetch } from "../../lib/vendors/polymarket";

/** Liquid names that print in US extended hours — must never soft-pass on noSessionTrade. */
export const LIVE_PROVIDER_EXTENDED_HOURS_SYMBOLS = ["SPY", "AAPL"] as const;

/** ScheduleV2 Input window tag (active sessions only; closed is never scheduled). */
export type LiveProviderCheckWindow = ActiveMarketSession;

export type LiveProviderCheckEvent = {
	id?: string;
	time?: string;
	window?: string;
	source?: string;
};

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

function isoDaysFromNow(days: number): string {
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Parse optional ScheduleV2 `window` tag; post-deploy / manual invokes omit it. */
export function parseLiveProviderCheckWindow(
	event: LiveProviderCheckEvent,
): LiveProviderCheckWindow | null {
	if (!Object.hasOwn(event, "window")) {
		return null;
	}
	const raw = event.window;
	if (raw === "pre" || raw === "regular" || raw === "after") {
		return raw;
	}
	throw new Error(`invalid live-provider-check window tag: ${JSON.stringify(raw)}`);
}

export type AssertLiveAssetPricesResult = { skipped: true; reason: string } | { skipped: false };

/**
 * Session-aware quote expectations for liquid extended-hours names.
 * Scheduled holiday/closed mismatch soft-skips (do not page); wrong active session fails.
 */
export async function assertLiveAssetPricesForSession(options: {
	session: MarketSession;
	scheduledWindow: LiveProviderCheckWindow | null;
	fetchPrices?: typeof fetchAssetPricesWithSessionState;
}): Promise<AssertLiveAssetPricesResult> {
	const { session, scheduledWindow } = options;
	const fetchPrices = options.fetchPrices ?? fetchAssetPricesWithSessionState;

	if (scheduledWindow !== null) {
		if (session === "closed") {
			return {
				skipped: true,
				reason: `scheduled window=${scheduledWindow} but market session=closed (holiday/half-day)`,
			};
		}
		if (session !== scheduledWindow) {
			throw new Error(
				`scheduled window=${scheduledWindow} but current market session=${session} (clock/calendar drift?)`,
			);
		}
	}

	const symbols = [...LIVE_PROVIDER_EXTENDED_HOURS_SYMBOLS];
	const { prices, noSessionTrade } = await fetchPrices(symbols, session);
	for (const symbol of symbols) {
		const quote = prices.get(symbol);
		if (quote && Number.isFinite(quote.price) && quote.price > 0) continue;
		throw new Error(
			`fetchAssetPricesWithSessionState(${symbol}) returned ${JSON.stringify(quote)}` +
				` (session=${session}, window=${scheduledWindow ?? "none"}, noSessionTrade=${noSessionTrade.has(symbol)})`,
		);
	}
	return { skipped: false };
}

/**
 * Run one check and log its outcome + wall-clock duration as a discrete step event.
 * The original version logged nothing per check, so the unbounded Telegram hang was
 * invisible — the log jumped straight from "Lambda invoke" to the 300s timeout. With
 * per-step timing, a slow or failing provider is attributable from the logs alone.
 * Steps log at `info` (even failures): the aggregate `error` + thrown exception below
 * is what escalates and pages; a single step result is just lifecycle telemetry.
 */
async function runCheck(
	logger: Logger,
	name: string,
	fn: () => Promise<void>,
): Promise<CheckResult> {
	const startedAt = Date.now();
	try {
		await fn();
		logger.info("Live provider check step", {
			action: "live_provider_check_step",
			check: name,
			ok: true,
			durationMs: Date.now() - startedAt,
		});
		return { name, ok: true, detail: "ok" };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		logger.info("Live provider check step", {
			action: "live_provider_check_step",
			check: name,
			ok: false,
			durationMs: Date.now() - startedAt,
			detail,
		});
		return { name, ok: false, detail };
	}
}

export type LiveProviderCheckResult = {
	ok: true;
	releaseId: string;
};

export async function handler(
	event: LiveProviderCheckEvent,
	context: Context,
): Promise<LiveProviderCheckResult> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "live-provider-check",
		});
		const scheduledWindow = parseLiveProviderCheckWindow(event);
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id ?? null,
			eventTime: event.time ?? null,
			window: scheduledWindow,
			source: event.source ?? null,
			releaseId: RELEASE_ID,
		});

		const checks: CheckResult[] = [
			await runCheck(logger, "massive:prev-close", async () => {
				const prev = await fetchPrevClose("SPY");
				if (prev === null || !Number.isFinite(prev) || prev <= 0) {
					throw new Error(`fetchPrevClose(SPY) returned ${prev}`);
				}
			}),
			await runCheck(logger, "massive:asset-prices", async () => {
				// Massive Starter unified snapshots (`GET /v3/snapshot`): liquid extended-hours
				// names (SPY/AAPL) must print under the active session's attribution rules
				// (pre: early_trading last_minute; regular/closed: session.close; after:
				// late_trading last_minute or session.close; closed prev-day fill). Do NOT
				// treat `noSessionTrade` as a pass — that reintroduced a stale-feed loophole.
				const session = await getCurrentMarketSession();
				const result = await assertLiveAssetPricesForSession({
					session,
					scheduledWindow,
				});
				if (result.skipped) {
					logger.info("Live provider asset-prices soft-skip", {
						action: "live_provider_asset_prices_skip",
						window: scheduledWindow,
						session,
						reason: result.reason,
					});
					return;
				}
				logger.info("Live provider asset-prices ok", {
					action: "live_provider_asset_prices_ok",
					window: scheduledWindow,
					session,
					symbols: LIVE_PROVIDER_EXTENDED_HOURS_SYMBOLS,
				});
			}),
			await runCheck(logger, "massive:daily-closes", async () => {
				const closes = await fetchDailyCloses("SPY", isoDaysFromNow(-7), isoDaysFromNow(0));
				if (!closes || closes.length === 0) {
					throw new Error("fetchDailyCloses(SPY) returned no closes");
				}
			}),
			await runCheck(logger, "finnhub:earnings", async () => {
				const result = await fetchEarnings(isoDaysFromNow(0), isoDaysFromNow(14));
				if (result.failed) {
					throw new Error("fetchEarnings reported failed=true");
				}
			}),
			await runCheck(logger, "massive:active-universe", async () => {
				// The daily universe reconcile's source. Verifying the entitlement here
				// (daily + post-deploy) means a broken listing feed fails a deploy red
				// instead of surfacing at the next maintenance run.
				const { tickers } = await fetchActiveTickers();
				if (tickers.length < MIN_PLAUSIBLE_ACTIVE_UNIVERSE) {
					throw new Error(
						`fetchActiveTickers returned ${tickers.length} listed tickers (floor ${MIN_PLAUSIBLE_ACTIVE_UNIVERSE})`,
					);
				}
			}),
			await runCheck(logger, "massive:ticker-branding", async () => {
				// The icon backfill's source. AAPL definitively has a logo, so ok-with-null
				// means the entitlement or response shape broke, not "no logo".
				const detail = await fetchTickerDetail("AAPL");
				if (!detail.ok || detail.iconUrl === null) {
					throw new Error(`fetchTickerDetail(AAPL) returned ${JSON.stringify(detail)}`);
				}
			}),
			await runCheck(logger, "polymarket:public-search", async () => {
				// Tracked-asset discovery uses Gamma public-search — not a full inventory crawl.
				const payload = await polymarketFetch(
					"/public-search",
					{
						q: "NVIDIA",
						events_status: "active",
						limit_per_type: "3",
						keep_closed_markets: "0",
					},
					"live-provider-check",
				);
				if (!isRecord(payload) || !Array.isArray(payload.events) || payload.events.length === 0) {
					throw new Error("polymarket public-search(NVIDIA) returned no events");
				}
			}),
			await runCheck(logger, "kalshi:companies-series", async () => {
				const seriesPayload = await kalshiFetch(
					"/series",
					{ limit: "5", category: "Companies" },
					"live-provider-check",
				);
				if (
					!isRecord(seriesPayload) ||
					!Array.isArray(seriesPayload.series) ||
					seriesPayload.series.length === 0
				) {
					throw new Error("kalshi /series?category=Companies returned no series");
				}
				const marketsPayload = await kalshiFetch(
					"/markets",
					{ limit: "3", status: "open", series_ticker: "KXTSLA" },
					"live-provider-check",
				);
				if (!isRecord(marketsPayload) || !Array.isArray(marketsPayload.markets)) {
					throw new Error("kalshi markets?series_ticker=KXTSLA returned invalid payload");
				}
			}),
			await runCheck(logger, "prediction-markets:curated-macro", async () => {
				// Digest Macro Weather — each active curated market must resolve as a
				// structured Yes/No or Up/Down binary (probabilities finite, totaling ~100).
				// Dated/rotating entries may set allowInactive and skip until hand-rotated.
				const cards = await fetchCuratedPredictionMarketCards({ logger });
				if (cards.length === 0) {
					throw new Error("curated prediction markets returned no active cards");
				}
				const gotKeys = new Set(cards.map((c) => c.key));
				for (const market of CURATED_PREDICTION_MARKETS) {
					if (gotKeys.has(market.key)) continue;
					if (market.allowInactive) {
						logger.warn("curated prediction market inactive (allowed)", {
							key: market.key,
						});
						continue;
					}
					throw new Error(`curated prediction market missing active card: ${market.key}`);
				}
				for (const card of cards) {
					assertStructuredBinaryCard(card);
				}
			}),
			await runCheck(logger, "chart:render-png", async () => {
				// No external API — proves the resvg wasm + font assets shipped in THIS bundle
				// and rasterize on the real Lambda runtime. Without it, a missing asset would
				// silently regress every Telegram price alert to text-only (renderChartPng
				// degrades to null by design; this check is where that degradation turns red).
				const probe: IntradayCandle[] = [
					{ o: 100, h: 101.2, l: 99.6, c: 100.8, t: 0 },
					{ o: 100.8, h: 101.6, l: 100.1, c: 100.4, t: 300_000 },
				];
				const svg = buildCandlestickSvg(probe, { prevClose: 100.2 });
				const png = await renderChartPng(svg);
				if (!png?.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
					throw new Error(
						"candlestick PNG render failed — chart wasm/font assets missing from the bundle?",
					);
				}
			}),
			await runCheck(logger, "telegram:get-me", async () => {
				// Read-only getMe()/getWebhookInfo() — undici reaches api.telegram.org where
				// grammY's node-fetch stalled (see createTelegramBot). No auto-retry: a one-shot
				// probe must fail fast with the real cause.
				const bot = createTelegramBot(readTelegramBotToken(), {
					timeoutSeconds: 10,
					withAutoRetry: false,
				});
				const report = await checkTelegramLive(bot).catch((error: unknown) => {
					// Surface the transport cause (undici throws a TypeError with .cause.code like
					// ENETUNREACH). grammY's HttpError.message is generic and `sensitiveLogs` would
					// leak the token — so unwrap .error manually. Learning WHY undici fails (if it
					// does) is the entire point of this check.
					if (error instanceof HttpError && error.error instanceof Error) {
						const code = (error.error.cause as { code?: string } | undefined)?.code;
						throw new Error(
							`telegram transport error: ${error.error.message}${code ? ` [${code}]` : ""}`,
						);
					}
					throw error;
				});
				if (!report.ok) {
					throw new Error(`getMe() returned no bot id (botId=${report.botId})`);
				}
			}),
		];

		const failed = checks.filter((c) => !c.ok);
		if (failed.length > 0) {
			logger.error("Live provider checks failed", {
				action: "live_provider_check",
				failedCount: failed.length,
				totalCount: checks.length,
				failures: failed.map((c) => ({ name: c.name, detail: c.detail })),
			});
			// Throw so AWS/Lambda Errors fires LiveProviderCheckFunctionErrorAlarm
			// → shared-infra SNS → enriched failure email.
			throw new Error(
				`Live provider checks failed (${failed.length}/${checks.length}): ${failed
					.map((c) => `${c.name} (${c.detail})`)
					.join("; ")}`,
			);
		}

		logger.info("Live provider checks passed", {
			action: "live_provider_check",
			totalCount: checks.length,
			checks: checks.map((c) => c.name),
			releaseId: RELEASE_ID,
		});
		return { ok: true as const, releaseId: RELEASE_ID };
	});
}
