/**
 * Live provider health check (EventBridge: 16:00 UTC weekdays; also post-deploy).
 * The only Lambda that makes real Massive/Finnhub round-trips — local tests always
 * stub vendors. Telegram probe is read-only (getMe/getWebhookInfo, never sends).
 * Throws on any failure so LiveProviderCheckFunctionErrorAlarm pages via SNS.
 */
import type { Context, ScheduledEvent } from "aws-lambda";
import { HttpError } from "grammy";
import { fetchEarnings } from "../../lib/asset-events/earnings";
import { createLogger, type Logger } from "../../lib/logging";
import { runLambda } from "../../lib/logging/request-context";
import { fetchDailyCloses, fetchPrevClose } from "../../lib/market-data/bars";
import { fetchAssetPrices } from "../../lib/market-data/prices";
import { getCurrentMarketSession } from "../../lib/market-data/session";
import { buildCandlestickSvg } from "../../lib/messaging/telegram/candlestick";
import { checkTelegramLive } from "../../lib/messaging/telegram/health";
import { renderChartPng } from "../../lib/messaging/telegram/render-png";
import { createTelegramBot, readTelegramBotToken } from "../../lib/messaging/telegram/sender";
import type { IntradayCandle } from "../../lib/types";

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

function isoDaysFromNow(days: number): string {
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "live-provider-check",
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
		});

		const checks: CheckResult[] = [
			await runCheck(logger, "massive:prev-close", async () => {
				const prev = await fetchPrevClose("SPY");
				if (prev === null || !Number.isFinite(prev) || prev <= 0) {
					throw new Error(`fetchPrevClose(SPY) returned ${prev}`);
				}
			}),
			await runCheck(logger, "massive:asset-prices", async () => {
				const session = await getCurrentMarketSession();
				const prices = await fetchAssetPrices(["SPY", "AAPL"], session);
				if (prices.size !== 2) {
					throw new Error(`fetchAssetPrices returned ${prices.size}/2 symbols`);
				}
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
		});
	});
}
