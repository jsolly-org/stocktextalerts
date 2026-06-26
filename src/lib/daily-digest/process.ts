import { DateTime } from "luxon";
import {
	type AssetEventsContent,
	buildAssetEventsContentForChannels,
} from "../asset-events/content";
import { updateUserAssetEventsNextSendAt } from "../asset-events/next-send-at";
import { assertIsoDateString, assertMinuteOfDay, assertYearMonthString } from "../domain/types";
import type { Logger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import { formatSignedChangePercent, formatUsdPrice } from "../messaging/asset-formatting";
import { buildDelayBannerHtml, buildDelayBannerText } from "../messaging/delay-banner";
import type { EmailSender } from "../messaging/email/utils";
import { type LogoCache, safePrefetchLogos } from "../messaging/logo-fetcher";
import { buildMarketClosedBannerText } from "../messaging/market-closure-banner";
import { anyFacetEnabled, enabledFacets, isFacetEnabled } from "../messaging/notification-prefs";
import { shouldSendSms } from "../messaging/sms";
import type { SmsExtras } from "../messaging/sms/delivery";
import type { SparklineMap } from "../messaging/sparkline";
import { formatDailyDigestTelegram } from "../messaging/telegram/digest";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import type { UserRecord } from "../messaging/types";
import { buildNewsContextForGrok, fetchFinnhubExtras } from "../providers/finnhub";
import type { GrokSectionResult } from "../providers/grok";
import { generateNewsWithGrok, generateRumorsWithGrok } from "../providers/grok";
import { fetchTopMovers, type TopMover } from "../providers/massive";
import {
	type AssetPriceMap,
	fetchAssetPricesWithSessionState,
	fetchIntradaySparklines,
	fetchSparklines,
	getCurrentMarketSession,
	type MarketSession,
} from "../providers/price-fetcher";
import { withOptionalVendorBudget } from "../providers/vendor-fault-tolerance";
import type { ScheduledNotificationTotals, SupabaseAdminClient } from "../schedule/helpers";
import { loadUserAssets } from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import type { TelegramSenderProvider } from "../schedule/telegram-sender";
import { upsertStagedNotification } from "../staged-notifications/db";
import type { StagedDailyData } from "../staged-notifications/types";
import { getUsMarketClosureInfoForInstant, type MarketClosureInfo } from "../time/market-calendar";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import {
	formatDailyDigestEmail,
	formatDailyDigestSmsMessageBodies,
	formatDigestQuoteAsOf,
	processDailyDigestEmailDelivery,
	processDailyDigestSmsDelivery,
	processDailyDigestTelegramDelivery,
} from "./delivery";
import { updateUserDailyDigestNextSendAt } from "./next-send-at";
import {
	deferDailyDigestProcessingRetry,
	getMaxDailyDigestSlotAttempts,
	MAX_NOTIFICATION_RETRIES,
	recordDailyDigestProcessingFailure,
	shouldAdvanceDailyDigestSchedule,
} from "./schedule-state";

const GROK_WINDOW_HOURS = 24;
const GROK_MAX_SENDS_PER_WINDOW = 10;

function formatMoverLine(mover: TopMover): string {
	return `${mover.ticker} — ${formatUsdPrice(mover.price)} (${formatSignedChangePercent(mover.changePercent)})`;
}

/**
 * Fetch market-wide top gainers/losers and format them as a single email
 * section body. Returns `null` when both lists are empty (upstream failure
 * or all tickers filtered out) — callers skip the section in that case.
 */
async function buildTopMoversSection(): Promise<string | null> {
	const moversResult = await withOptionalVendorBudget("top-movers", 10_000, async () => {
		const [gainers, losers] = await Promise.all([
			fetchTopMovers("gainers", { optional: true }),
			fetchTopMovers("losers", { optional: true }),
		]);
		return { gainers, losers };
	});
	if (moversResult.status !== "ok") {
		return null;
	}
	const { gainers, losers } = moversResult.value;
	const lines: string[] = [];
	if (gainers.length > 0) {
		lines.push("Gainers:");
		for (const m of gainers) lines.push(formatMoverLine(m));
	}
	if (losers.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Losers:");
		for (const m of losers) lines.push(formatMoverLine(m));
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/** Return whether Grok is allowed within the user's rolling window limit. */
function canInvokeGrokWithinLimit(options: {
	grokWindowStart: string | null;
	grokSendsInWindow: number;
	currentTimeUtc: DateTime;
}): boolean {
	const { grokWindowStart, grokSendsInWindow, currentTimeUtc } = options;
	if (!grokWindowStart) {
		return true;
	}
	const windowStart = DateTime.fromISO(grokWindowStart, { zone: "utc" });
	if (!windowStart.isValid) {
		return true;
	}
	// If the window has expired, the counter will be reset — allow the send.
	if (currentTimeUtc.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS) {
		return true;
	}
	// Within the window — check the counter.
	return grokSendsInWindow < GROK_MAX_SENDS_PER_WINDOW;
}

interface DailyScheduleContext {
	scheduledDate: string;
	scheduledMinutes: number;
}

/** Derive the (scheduledDate, scheduledMinutes) key for daily digest delivery. */
function parseDailyScheduleContext(
	user: UserRecord,
	currentTime: DateTime,
	logger: Logger,
): DailyScheduleContext | null {
	const dueAt = user.daily_digest_next_send_at
		? DateTime.fromISO(user.daily_digest_next_send_at, { zone: "utc" })
		: currentTime;
	if (!dueAt.isValid) {
		logger.error(
			"Invalid daily_digest_next_send_at timestamp",
			{
				userId: user.id,
				daily_digest_next_send_at: user.daily_digest_next_send_at,
			},
			new Error("Invalid daily_digest_next_send_at timestamp"),
		);
		return null;
	}
	const dueAtLocal = dueAt.setZone(user.timezone);
	if (!dueAtLocal.isValid) {
		logger.error(
			"Failed to format local date for timezone (daily)",
			{ userId: user.id, timezone: user.timezone },
			new Error("Failed to format local date for timezone"),
		);
		return null;
	}
	const scheduledDate = dueAtLocal.toISODate();
	if (!scheduledDate) {
		logger.error(
			"Failed to format scheduled date (daily)",
			{
				userId: user.id,
				timezone: user.timezone,
				daily_digest_next_send_at: user.daily_digest_next_send_at,
			},
			new Error("Failed to format scheduled date"),
		);
		return null;
	}
	const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
	if (scheduledMinutes === null) {
		logger.error(
			"Failed to calculate scheduled minutes (daily)",
			{
				action: "daily_run",
				userId: user.id,
				timezone: user.timezone,
				daily_digest_next_send_at: user.daily_digest_next_send_at,
				scheduledDate,
			},
			new Error("Failed to calculate scheduled minutes"),
		);
		return null;
	}
	return { scheduledDate, scheduledMinutes };
}

/** Resolve whether Grok can be used for this digest run. */
function resolveGrokEligibility(
	user: UserRecord,
	needsGrok: boolean,
	currentTimeUtc: DateTime,
	logger: Logger,
	scheduledDate: string,
	scheduledMinutes: number,
): { grokAllowed: boolean } {
	const grokAllowed =
		needsGrok &&
		canInvokeGrokWithinLimit({
			grokWindowStart: user.grok_window_start,
			grokSendsInWindow: user.grok_sends_in_window,
			currentTimeUtc,
		});

	if (needsGrok && !grokAllowed) {
		logger.info(
			"Grok send limit reached for this window; digest will proceed without news/rumors",
			{
				action: "daily_run",
				reason: "grok_limit",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				grokSendsInWindow: user.grok_sends_in_window,
			},
		);
	}

	return { grokAllowed };
}

/** Persist Grok usage counters after at least one successful delivery. */
async function updateGrokSendCounter(
	user: UserRecord,
	supabase: SupabaseAdminClient,
	grokAllowed: boolean,
	stats: ScheduledNotificationTotals,
	currentTime: DateTime,
	logger: Logger,
): Promise<void> {
	// Count a Grok send on ANY delivered channel, including Telegram — otherwise a
	// telegram-only user's Grok rate-limit counter never advances (the staged path
	// already includes telegram; keep the live path consistent).
	if (!grokAllowed || (stats.emailsSent === 0 && stats.smsSent === 0 && stats.telegramSent === 0)) {
		return;
	}

	const now = currentTime.toISO();
	if (!now) return;

	// If the window has expired (or never started), reset the counter.
	const windowStart = user.grok_window_start
		? DateTime.fromISO(user.grok_window_start, { zone: "utc" })
		: null;
	const windowExpired =
		!windowStart?.isValid || currentTime.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS;

	const newCount = windowExpired ? 1 : user.grok_sends_in_window + 1;
	const newWindowStart = windowExpired ? now : user.grok_window_start;

	user.grok_sends_in_window = newCount;
	user.grok_window_start = newWindowStart;
	user.last_grok_rumors_at = now;

	const { error } = await supabase
		.from("users")
		.update({
			last_grok_rumors_at: now,
			grok_window_start: newWindowStart,
			grok_sends_in_window: newCount,
		})
		.eq("id", user.id);
	if (error) {
		logger.error(
			"Failed to update grok send counter (daily)",
			{ userId: user.id, newCount, newWindowStart },
			error,
		);
	}
}

/** Process one user's daily digest notification (deliver now or stage for later). */
export async function processDailyDigestUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	getTelegramSender: TelegramSenderProvider;
	/** When true, stage content for later delivery instead of sending now. */
	stageOnly?: boolean;
	/** Pre-fetched market open status (avoids per-user API calls in fan-out). */
	marketOpen?: boolean;
	/** Pre-fetched market closure info (avoids per-user API calls in fan-out). */
	marketClosureInfo?: MarketClosureInfo | null;
	/** Shared per-pass logo cache so a symbol's logo is resolved once per pass, not per user. */
	logoCache?: LogoCache;
}): Promise<ScheduledNotificationTotals> {
	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
	};
	const {
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		getTelegramSender,
		stageOnly,
		marketOpen: marketOpenParam,
		marketClosureInfo: marketClosureInfoParam,
	} = options;

	try {
		const scheduleCtx = parseDailyScheduleContext(user, currentTime, logger);
		if (!scheduleCtx) {
			stats.skipped++;
			return stats;
		}
		const { scheduledDate, scheduledMinutes } = scheduleCtx;

		const dueAt = user.daily_digest_next_send_at
			? DateTime.fromISO(user.daily_digest_next_send_at, { zone: "utc" })
			: currentTime;
		const delayBannerOpts = {
			scheduledFor: dueAt.isValid ? dueAt : currentTime,
			now: currentTime,
			userTimezone: user.timezone,
			use24Hour: user.use_24_hour_time,
		};
		const delayBannerText = stageOnly ? null : buildDelayBannerText(delayBannerOpts);
		const delayBannerHtml = stageOnly ? null : buildDelayBannerHtml(delayBannerOpts);

		const hasAnyAssetEventsOption =
			anyFacetEnabled(user.prefs, "asset_events", "email") ||
			anyFacetEnabled(user.prefs, "asset_events", "sms");

		const userAssets = await loadUserAssets(supabase, user.id, {
			includeLogoData: true,
		});
		const tickers = userAssets.map((s) => s.symbol);

		const emailEnabled = user.email_notifications_enabled;
		const smsEnabled = shouldSendSms(user);

		// All channel preferences (incl. Telegram) live in notification_preferences,
		// carried on user.prefs. Telegram still gates on the usable-channel check
		// (linked + not opted out) in addition to a per-option facet row.
		const telegramFacets = enabledFacets(user.prefs, "daily_digest", "telegram");
		const telegramEnabled = isTelegramChannelUsable(user) && telegramFacets.size > 0;
		const wantsTopMoversTelegram = telegramEnabled && telegramFacets.has("top_movers");
		const includePricesTelegram = telegramEnabled && telegramFacets.has("prices");

		const needsGrok =
			emailEnabled &&
			(isFacetEnabled(user.prefs, "daily_digest", "email", "news") ||
				isFacetEnabled(user.prefs, "daily_digest", "email", "rumors"));
		const { grokAllowed } = resolveGrokEligibility(
			user,
			needsGrok,
			currentTime,
			logger,
			scheduledDate,
			scheduledMinutes,
		);

		const wantsTopMoversEmail =
			isFacetEnabled(user.prefs, "daily_digest", "email", "top_movers") && emailEnabled;
		const wantsTopMoversSms =
			isFacetEnabled(user.prefs, "daily_digest", "sms", "top_movers") && smsEnabled;
		const wantsTopMovers = wantsTopMoversEmail || wantsTopMoversSms || wantsTopMoversTelegram;

		if (!emailEnabled && !smsEnabled && !telegramEnabled) {
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyDigestNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
			}
			return stats;
		}

		const includePricesEmail = isFacetEnabled(user.prefs, "daily_digest", "email", "prices");
		const includePricesSms = isFacetEnabled(user.prefs, "daily_digest", "sms", "prices");
		const needsPrices =
			(includePricesEmail && emailEnabled) ||
			(includePricesSms && smsEnabled) ||
			includePricesTelegram;

		// Resolve the market session once for this user so the price fetch
		// below and the marketOpen derivation later share a single
		// /v1/marketstatus/now round-trip. When the orchestrator pre-fetched
		// and passed marketOpenParam, reuse it.
		const session: MarketSession =
			marketOpenParam === true
				? "regular"
				: marketOpenParam === false
					? "closed"
					: await getCurrentMarketSession();

		let assetPrices: AssetPriceMap = new Map();
		let noSessionTradeTickers: Set<string> = new Set();
		if (needsPrices && tickers.length > 0) {
			try {
				const result = await fetchAssetPricesWithSessionState(tickers, session);
				assetPrices = result.prices;
				noSessionTradeTickers = result.noSessionTrade;
			} catch (error) {
				logger.error(
					"Failed to fetch daily digest prices",
					{ action: "daily_run", userId: user.id, tickerCount: tickers.length },
					createErrorForLogging(error),
				);
			}
		}

		// Sparkline window mirrors what we headline next to it. When the digest
		// shows today's % (any active session), the chart is intraday-since-prev-close
		// so its first-to-last delta equals that %. When the market is closed
		// (weekend/holiday) the digest hides change-% entirely; fall back to
		// the 7-trading-day chart to give the reader a weekly trend at a glance.
		let sparklines: SparklineMap = new Map();
		if (needsPrices && tickers.length > 0) {
			try {
				if (session === "closed") {
					sparklines = await fetchSparklines(tickers, {
						supabase,
						timezone: user.timezone,
						use24HourTime: user.use_24_hour_time,
					});
				} else {
					const prevCloseMap = new Map<string, number | null | undefined>();
					const currentPriceMap = new Map<string, number | null | undefined>();
					for (const [symbol, quote] of assetPrices) {
						if (quote) {
							prevCloseMap.set(symbol, quote.prevClose);
							currentPriceMap.set(symbol, quote.price);
						}
					}
					// A preceding price-fetch error leaves assetPrices empty, which
					// means every sparkline silently falls back to the since-open
					// window. Surface the degradation here so the chain shows up
					// in shared-infra triage, not just the upstream error.
					if (prevCloseMap.size === 0) {
						logger.warn(
							"Daily digest sparklines defaulting to intraday-since-open: no prev closes available",
							{
								action: "daily_run",
								userId: user.id,
								tickerCount: tickers.length,
								session,
							},
						);
					}
					sparklines = await fetchIntradaySparklines(tickers, prevCloseMap, currentPriceMap, {
						supabase,
						timezone: user.timezone,
						use24HourTime: user.use_24_hour_time,
					});
				}
			} catch (error) {
				logger.error(
					"Failed to fetch sparklines for daily digest",
					{ action: "daily_run", userId: user.id, tickerCount: tickers.length, session },
					createErrorForLogging(error),
				);
			}
		}

		const { getLogoHtml } = await safePrefetchLogos({
			assets: userAssets,
			shouldPrefetch: needsPrices && emailEnabled,
			supabase,
			logger,
			logContext: { action: "daily_run", userId: user.id },
			cache: options.logoCache,
		});

		// Classify tickers without prices into two buckets:
		//  - noSessionTradeTickers: Massive recognized the symbol but no trade
		//    exists for the active session yet (illiquid pre/after-hours name).
		//    On closed sessions this set is always empty because
		//    fetchAssetPricesWithSessionState either backfills the entry with a
		//    prev-day bar or downgrades it to null when the bar fetch fails —
		//    the null path then surfaces as a real miss below.
		//  - missingTickers: real fetch miss (delisted, OTC, vendor outage on
		//    the snapshot or prev-day-bar endpoint). Page-worthy regardless of
		//    session — a missing price means the digest can't render its
		//    headline number for that asset.
		if (tickers.length > 0 && needsPrices) {
			const missingTickers = tickers.filter(
				(ticker) => assetPrices.get(ticker) === null && !noSessionTradeTickers.has(ticker),
			);
			if (missingTickers.length > 0) {
				logger.error(
					"Daily digest prices missing after fetch",
					{
						action: "daily_run",
						userId: user.id,
						missingCount: missingTickers.length,
						missingTickers,
						session,
					},
					new Error(`Missing prices for tickers: ${missingTickers.join(", ")}`),
				);
			}
			if (noSessionTradeTickers.size > 0) {
				logger.info("Daily digest tickers had no live session trade", {
					action: "daily_run",
					userId: user.id,
					noSessionTradeCount: noSessionTradeTickers.size,
					noSessionTradeTickers: Array.from(noSessionTradeTickers),
					session,
				});
			}
		}

		// Check whether the US market is closed today (weekend / holiday).
		// Use the user's scheduled send instant (not job execution time) so digests
		// near US midnight classify the correct market day during precompute.
		const closureRefInstant = user.daily_digest_next_send_at
			? DateTime.fromISO(user.daily_digest_next_send_at, { zone: "utc" })
			: currentTime;
		const marketClosureInfo =
			marketClosureInfoParam !== undefined
				? marketClosureInfoParam
				: await getUsMarketClosureInfoForInstant(closureRefInstant);

		const marketOpen = session === "regular";

		/* =============
		Fetch Finnhub/Massive news for Grok (email-only; skip when not opted in)
		============= */
		let newsContext: string | undefined;
		const wantsNewsContext =
			emailEnabled &&
			grokAllowed &&
			isFacetEnabled(user.prefs, "daily_digest", "email", "news") &&
			tickers.length > 0;
		if (wantsNewsContext) {
			const finnhubNews = await fetchFinnhubExtras(tickers, {
				includeNews: true,
				includeAnalyst: false,
				includeInsider: false,
			});
			newsContext = buildNewsContextForGrok(finnhubNews.news) || undefined;
		}

		// Grok news/rumors are email-only (SMS body can exceed Twilio's 1600-char limit)
		let newsResult: GrokSectionResult | null = null;
		let rumorsResult: GrokSectionResult | null = null;

		if (grokAllowed && emailEnabled) {
			[newsResult, rumorsResult] = await Promise.all([
				isFacetEnabled(user.prefs, "daily_digest", "email", "news")
					? generateNewsWithGrok({
							tickers,
							localDateIso: scheduledDate,
							timezone: user.timezone,
							finnhubNewsContext: newsContext || undefined,
						})
					: Promise.resolve(null),
				isFacetEnabled(user.prefs, "daily_digest", "email", "rumors")
					? generateRumorsWithGrok({
							tickers,
							localDateIso: scheduledDate,
							timezone: user.timezone,
						})
					: Promise.resolve(null),
			]);
		}

		/* =============
		Fetch market-wide top movers (email and/or SMS when opted in)
		============= */
		const topMoversSection = wantsTopMovers ? await buildTopMoversSection() : null;

		const mergedCitations = [
			...new Set([...(newsResult?.citations ?? []), ...(rumorsResult?.citations ?? [])]),
		];
		if (mergedCitations.length > 0) {
			logger.info("Grok citations returned", {
				action: "daily_run",
				userId: user.id,
				citationCount: mergedCitations.length,
				citations: mergedCitations,
			});
		}

		/* =============
		Build asset events content (bundled into daily digest)
		============= */
		const dueAtLocal = (
			user.daily_digest_next_send_at
				? DateTime.fromISO(user.daily_digest_next_send_at, { zone: "utc" })
				: currentTime
		).setZone(user.timezone);
		const localDate = dueAtLocal.toISODate() ?? "";

		let emailAssetEvents: AssetEventsContent | null = null;
		let smsAssetEvents: AssetEventsContent | null = null;
		let shouldUpdateAnalystMonth = false;

		if (hasAnyAssetEventsOption) {
			const wantsAssetEventsEmail =
				emailEnabled && anyFacetEnabled(user.prefs, "asset_events", "email");
			const wantsAssetEventsSms = smsEnabled && anyFacetEnabled(user.prefs, "asset_events", "sms");

			const assetEventChannels: Array<"email" | "sms"> = [];
			if (wantsAssetEventsEmail) assetEventChannels.push("email");
			if (wantsAssetEventsSms) assetEventChannels.push("sms");

			if (assetEventChannels.length > 0) {
				const built = await buildAssetEventsContentForChannels({
					user,
					supabase,
					logger,
					localDate,
					tickers,
					channels: assetEventChannels,
				});
				emailAssetEvents = built.email;
				smsAssetEvents = built.sms;
				shouldUpdateAnalystMonth = built.shouldUpdateAnalystMonth;
			}
		}

		/* =============
		Build extras per channel
		============= */
		const buildExtras = (channel: "email" | "sms"): SmsExtras => {
			const isSms = channel === "sms";
			const wantsTopMoversForChannel = isSms ? wantsTopMoversSms : wantsTopMoversEmail;
			return {
				news: isSms ? null : (newsResult?.content ?? null),
				rumors: isSms ? null : (rumorsResult?.content ?? null),
				analyst: null,
				insider: null,
				topMovers: wantsTopMoversForChannel ? topMoversSection : null,
				citations: !isSms && mergedCitations.length > 0 ? mergedCitations : undefined,
			};
		};

		const emailExtras = emailEnabled ? buildExtras("email") : null;
		const smsExtras = smsEnabled ? buildExtras("sms") : null;

		// Telegram extras: v1 carries prices (+ top movers when that facet is on
		// for Telegram). Grok news/rumors are intentionally omitted on Telegram —
		// see the dispatch wiring note. Reuses the rich (email-style) topMovers
		// section already fetched above.
		const telegramExtras: SmsExtras | null = telegramEnabled
			? {
					news: null,
					rumors: null,
					analyst: null,
					insider: null,
					topMovers: wantsTopMoversTelegram ? topMoversSection : null,
				}
			: null;

		const emailPriceAssets = includePricesEmail ? userAssets : [];
		const emailPriceMap = includePricesEmail ? assetPrices : new Map();
		const smsPriceAssets = includePricesSms ? userAssets : [];
		const smsPriceMap = includePricesSms ? assetPrices : new Map();
		const telegramPriceAssets = includePricesTelegram ? userAssets : [];
		const telegramPriceMap = includePricesTelegram ? assetPrices : new Map();
		const hasEmailContent = !!(
			(includePricesEmail && userAssets.length > 0 && emailEnabled) ||
			emailExtras?.news ||
			emailExtras?.rumors ||
			emailExtras?.topMovers ||
			emailAssetEvents?.hasAnyContent
		);
		const hasSmsContent = !!(
			(includePricesSms && userAssets.length > 0 && smsEnabled) ||
			(smsEnabled && smsExtras?.topMovers) ||
			smsAssetEvents?.hasAnyContent
		);
		const hasTelegramContent = !!(
			(includePricesTelegram && userAssets.length > 0) ||
			telegramExtras?.topMovers
		);

		// Shared Telegram render inputs for both the stage-only render and the live
		// delivery below — defined once so the date format and closed-market banner gate
		// can't drift between the two paths.
		const telegramDateLabel = dueAtLocal.isValid
			? dueAtLocal.toFormat("ccc, LLL d")
			: (scheduledDate ?? "");
		const telegramMarketBanner =
			marketOpen === false
				? buildMarketClosedBannerText(
						marketClosureInfo,
						"prices",
						formatDigestQuoteAsOf(telegramPriceMap, user.use_24_hour_time),
					)
				: null;

		if (!hasEmailContent && !hasSmsContent && !hasTelegramContent) {
			logger.info("Skipping daily digest: no content available", {
				action: "daily_run",
				reason: "no_content",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyDigestNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
				if (hasAnyAssetEventsOption) {
					await updateUserAssetEventsNextSendAt({
						user,
						supabase,
						logger,
						currentTime,
					});
				}
			}
			return stats;
		}

		/* ============= Stage-only: write to staging table and return ============= */
		// Pre-compute path: render the full digest (prices, Grok, asset events) now
		// and store it in staged_notifications for near-instant delivery later.
		// We do NOT advance next_send_at, update Grok counters, or update the
		// analyst month here — the delivery phase (staged-notifications/deliver.ts)
		// handles all post-delivery side-effects using metadata captured below
		// (grokAllowed, hasAnyAssetEventsOption, shouldUpdateAnalyst, analystMonth).
		if (stageOnly) {
			const scheduledForIso = user.daily_digest_next_send_at ?? currentTime.toISO();
			if (!scheduledForIso) {
				logger.error(
					"Cannot determine scheduled_for for daily staging",
					{ userId: user.id },
					new Error("Cannot determine scheduled_for for daily staging"),
				);
				stats.skipped++;
				return stats;
			}

			const emailContent =
				hasEmailContent && emailExtras
					? formatDailyDigestEmail({
							user,
							is24Hour: user.use_24_hour_time,
							userAssets: emailPriceAssets,
							assetPrices: emailPriceMap,
							extras: emailExtras,
							assetEvents: emailAssetEvents,
							sparklines,
							marketOpen,
							marketClosureInfo,
							getLogoHtml,
						})
					: null;

			const smsContent =
				hasSmsContent && smsExtras
					? {
							messages: formatDailyDigestSmsMessageBodies({
								userAssets: smsPriceAssets,
								assetPrices: smsPriceMap,
								extras: smsExtras,
								assetEvents: smsAssetEvents,
								sparklines,
								marketOpen,
								marketClosureInfo,
								is24Hour: user.use_24_hour_time,
							}),
						}
					: null;

			// Telegram is rendered to its final text + parse-mode entities here so the
			// deliver phase can send it verbatim (mirrors email/SMS staging above).
			const telegramFormatted =
				hasTelegramContent && telegramExtras
					? formatDailyDigestTelegram({
							userAssets: telegramPriceAssets,
							assetPrices: telegramPriceMap,
							extras: telegramExtras,
							dateLabel: telegramDateLabel,
							delayBanner: delayBannerText,
							marketClosedBanner: telegramMarketBanner,
						})
					: null;
			const telegramContent = telegramFormatted
				? { text: telegramFormatted.text, entities: [...telegramFormatted.entities] }
				: null;

			const shouldUpdateAnalyst = shouldUpdateAnalystMonth;

			const stagedData: StagedDailyData = {
				type: "daily",
				scheduledDate: assertIsoDateString(scheduledDate),
				scheduledMinutes: assertMinuteOfDay(scheduledMinutes),
				email: emailContent,
				sms: smsContent,
				telegram: telegramContent,
				grokAllowed,
				hasAnyAssetEventsOption,
				shouldUpdateAnalyst,
				analystMonth: shouldUpdateAnalyst
					? assertYearMonthString(dueAtLocal.toFormat("yyyy-MM"))
					: null,
			};

			const { error: stageError } = await upsertStagedNotification(supabase, {
				userId: user.id,
				notificationType: "daily",
				scheduledFor: scheduledForIso,
				stagedData,
			});

			if (stageError) {
				logger.error("Failed to stage daily digest notification", { userId: user.id }, stageError);
				stats.skipped++;
			}

			return stats;
		}

		if (hasEmailContent && emailExtras) {
			await processDailyDigestEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets: emailPriceAssets,
				assetPrices: emailPriceMap,
				extras: emailExtras,
				assetEvents: emailAssetEvents,
				sparklines,
				marketOpen,
				marketClosureInfo,
				sendEmail,
				stats,
				getLogoHtml,
				delayBannerText,
				delayBannerHtml,
			});
		}

		if (hasSmsContent && smsExtras) {
			await processDailyDigestSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets: smsPriceAssets,
				assetPrices: smsPriceMap,
				extras: smsExtras,
				assetEvents: smsAssetEvents,
				sparklines,
				marketOpen,
				marketClosureInfo,
				getSmsSender,
				stats,
				delayBanner: delayBannerText,
			});
		}

		if (hasTelegramContent && telegramExtras) {
			await processDailyDigestTelegramDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets: telegramPriceAssets,
				assetPrices: telegramPriceMap,
				extras: telegramExtras,
				dateLabel: telegramDateLabel,
				marketClosedBanner: telegramMarketBanner,
				getTelegramSender,
				stats,
			});
		}

		await updateGrokSendCounter(user, supabase, grokAllowed, stats, currentTime, logger);

		/* =============
		Advance next-send-at for daily + asset events (only when delivery is terminal)
		============= */
		const emailRequired = hasEmailContent && emailEnabled;
		const smsRequired = hasSmsContent && smsEnabled;
		const telegramRequired = hasTelegramContent && telegramEnabled;
		const canAdvance = await shouldAdvanceDailyDigestSchedule({
			supabase,
			user,
			scheduledDate,
			scheduledMinutes,
			emailRequired,
			smsRequired,
			telegramRequired,
		});

		if (canAdvance) {
			await updateUserDailyDigestNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});

			if (hasAnyAssetEventsOption) {
				await updateUserAssetEventsNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
			}
		} else {
			logger.info("Deferring daily digest schedule advance pending delivery retries", {
				action: "daily_run",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				emailRequired,
				smsRequired,
				telegramRequired,
			});
		}

		if (shouldUpdateAnalystMonth && canAdvance) {
			const currentMonth = dueAtLocal.toFormat("yyyy-MM");
			const { error: analystError } = await supabase
				.from("users")
				.update({ asset_events_last_analyst_sent_month: currentMonth })
				.eq("id", user.id);
			if (analystError) {
				logger.error(
					"Failed to update asset_events_last_analyst_sent_month",
					{ userId: user.id },
					analystError,
				);
			}
		}

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing daily digest user", { userId: user.id }, error);
		const scheduleCtxOnError = parseDailyScheduleContext(user, currentTime, logger);
		if (!stageOnly && scheduleCtxOnError) {
			await recordDailyDigestProcessingFailure({
				supabase,
				user,
				scheduledDate: scheduleCtxOnError.scheduledDate,
				scheduledMinutes: scheduleCtxOnError.scheduledMinutes,
				logger,
			});
			const priorAttempts = await getMaxDailyDigestSlotAttempts({
				supabase,
				userId: user.id,
				scheduledDate: scheduleCtxOnError.scheduledDate,
				scheduledMinutes: scheduleCtxOnError.scheduledMinutes,
			});
			if (priorAttempts >= MAX_NOTIFICATION_RETRIES) {
				try {
					await updateUserDailyDigestNextSendAt({
						user,
						supabase,
						logger,
						currentTime,
					});
				} catch (updateError) {
					logger.error(
						"Failed to update daily_digest_next_send_at after daily digest error",
						{ userId: user.id },
						updateError,
					);
				}
			} else {
				await deferDailyDigestProcessingRetry({
					supabase,
					user,
					logger,
					currentTime,
					deferralCount: priorAttempts,
				});
			}
		}
		return stats;
	}
}
