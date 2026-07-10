import type { DateTime } from "luxon";
import { buildAssetEventsContentForChannels } from "../asset-events/content";
import type { AssetEventsContent, AssetEventsTelegramFacets } from "../asset-events/types";
import {
	anyDailyAssetEventFacetEnabled,
	enabledDailyNotificationFacets,
	hasAnyDailyAssetEventFacet,
	isDailyNotificationFacetEnabled,
} from "../daily-notification/eligibility";
import { updateUserDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import { loadUserAssets } from "../db/user-assets";
import type { Logger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import { fetchAssetPricesWithSessionState } from "../market-data/prices";
import { getCurrentMarketSession } from "../market-data/session";
import { fetchIntradaySparklines, fetchSparklines } from "../market-data/sparklines";
import { type LogoCache, safePrefetchLogos } from "../messaging/logo-fetcher";
import { buildDelayBannerHtml, buildDelayBannerText } from "../messaging/parts/delay";
import type { SparklineMap } from "../messaging/parts/sparkline";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender, NotificationExtras } from "../messaging/types";
import { buildPredictionMarketsDigestContent } from "../prediction-markets/content";
import { MAX_NOTIFICATION_RETRIES } from "../scheduled-notifications/constants";
import { getMaxDailyDigestSlotAttempts } from "../scheduled-notifications/store";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { getUsMarketClosureInfoForInstant } from "../time/market/calendar";
import { parseScheduledSlotContext } from "../time/schedule/next-send";
import type { MarketClosureInfo } from "../time/types";
import type { AssetPriceMap, MarketSession, UserRecord } from "../types";
import { buildTopMoversData, resolveGrokEligibility, updateGrokSendCounter } from "./content-build";
import { processDailyDigestEmailDelivery, processDailyDigestTelegramDelivery } from "./delivery";
import { buildNewsContextForGrok, fetchDigestExtras } from "./digest-extras";
import type { GrokSectionResult } from "./grok-sections";
import { generateNewsWithGrok, generateRumorsWithGrok } from "./grok-sections";
import {
	deferDailyDigestProcessingRetry,
	recordDailyDigestProcessingFailure,
	shouldAdvanceDailyDigestSchedule,
} from "./schedule-state";
import { stageDailyDigestContent } from "./stage";

/** Process one user's daily digest notification (deliver now or stage for later). */
export async function processDailyDigestUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getTelegramSender: TelegramSenderFactory;
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
		telegramSent: 0,
		telegramFailed: 0,
	};
	const {
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getTelegramSender,
		stageOnly,
		marketOpen: marketOpenParam,
		marketClosureInfo: marketClosureInfoParam,
	} = options;

	try {
		const scheduleCtx = parseScheduledSlotContext({
			cursorIso: user.daily_notification_next_send_at,
			cursorField: "daily_notification_next_send_at",
			timezone: user.timezone,
			userId: user.id,
			currentTime,
			logger,
			logLabel: " (daily)",
			action: "daily_run",
		});
		if (!scheduleCtx) {
			stats.skipped++;
			return stats;
		}
		const { scheduledDate, scheduledMinutes, dueAt } = scheduleCtx;

		const delayBannerOpts = {
			scheduledFor: dueAt,
			now: currentTime,
			userTimezone: user.timezone,
			use24Hour: user.use_24_hour_time,
		};
		const delayBannerText = stageOnly ? null : buildDelayBannerText(delayBannerOpts);
		const delayBannerHtml = stageOnly ? null : buildDelayBannerHtml(delayBannerOpts);

		const hasAnyAssetEventsOption = hasAnyDailyAssetEventFacet(user.prefs);

		const userAssets = await loadUserAssets(supabase, user.id, {
			includeLogoData: true,
		});
		const tickers = userAssets.map((s) => s.symbol);

		const emailEnabled = user.email_notifications_enabled;

		// All channel preferences (incl. Telegram) live in notification_preferences,
		// carried on user.prefs. Telegram still gates on the usable-channel check
		// (linked + not opted out) in addition to a per-option facet row.
		const telegramFacets = enabledDailyNotificationFacets(user.prefs, "telegram");
		const telegramEnabled = isTelegramChannelUsable(user) && telegramFacets.size > 0;
		const wantsTopMoversTelegram = telegramEnabled && telegramFacets.has("top_movers");
		const includePricesTelegram = telegramEnabled && telegramFacets.has("prices");

		const needsGrok =
			emailEnabled &&
			(isDailyNotificationFacetEnabled(user.prefs, "email", "news") ||
				isDailyNotificationFacetEnabled(user.prefs, "email", "rumors"));
		const { grokAllowed } = resolveGrokEligibility(
			user,
			needsGrok,
			currentTime,
			logger,
			scheduledDate,
			scheduledMinutes,
		);

		const wantsTopMoversEmail =
			isDailyNotificationFacetEnabled(user.prefs, "email", "top_movers") && emailEnabled;
		const wantsTopMovers = wantsTopMoversEmail || wantsTopMoversTelegram;
		const wantsPredictionMarketsEmail =
			emailEnabled && isDailyNotificationFacetEnabled(user.prefs, "email", "prediction_markets");
		const wantsPredictionMarketsTelegram =
			telegramEnabled && telegramFacets.has("prediction_markets");
		const wantsPredictionMarkets = wantsPredictionMarketsEmail || wantsPredictionMarketsTelegram;

		if (!emailEnabled && !telegramEnabled) {
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyNotificationNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
			}
			return stats;
		}

		const includePricesEmail = isDailyNotificationFacetEnabled(user.prefs, "email", "prices");
		const needsPrices = (includePricesEmail && emailEnabled) || includePricesTelegram;

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
		//  - noSessionTradeTickers: the vendor recognized the symbol but no trade
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
		const closureRefInstant = dueAt;
		const marketClosureInfo =
			marketClosureInfoParam !== undefined
				? marketClosureInfoParam
				: await getUsMarketClosureInfoForInstant(closureRefInstant);

		const marketOpen = session === "regular";

		/* =============
		Fetch Massive news for Grok (email-only; skip when not opted in)
		============= */
		let newsContext: string | undefined;
		const wantsNewsContext =
			emailEnabled &&
			grokAllowed &&
			isDailyNotificationFacetEnabled(user.prefs, "email", "news") &&
			tickers.length > 0;
		if (wantsNewsContext) {
			const digestExtras = await fetchDigestExtras(tickers, {
				includeNews: true,
				includeAnalyst: false,
				includeInsider: false,
			});
			newsContext = buildNewsContextForGrok(digestExtras.news) || undefined;
		}

		// Grok news/rumors are email-only.
		let newsResult: GrokSectionResult | null = null;
		let rumorsResult: GrokSectionResult | null = null;

		if (grokAllowed && emailEnabled) {
			[newsResult, rumorsResult] = await Promise.all([
				isDailyNotificationFacetEnabled(user.prefs, "email", "news")
					? generateNewsWithGrok({
							tickers,
							localDateIso: scheduledDate,
							timezone: user.timezone,
							providerNewsContext: newsContext || undefined,
						})
					: Promise.resolve(null),
				isDailyNotificationFacetEnabled(user.prefs, "email", "rumors")
					? generateRumorsWithGrok({
							tickers,
							localDateIso: scheduledDate,
							timezone: user.timezone,
						})
					: Promise.resolve(null),
			]);
		}

		/* =============
		Fetch market-wide top movers (email/Telegram when opted in)
		============= */
		const topMoversSection = wantsTopMovers ? await buildTopMoversData() : null;
		const predictionMarketsDigest = wantsPredictionMarkets
			? await buildPredictionMarketsDigestContent({
					supabase,
					logger,
					userAssets,
				})
			: null;

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
		const dueAtLocal = dueAt.setZone(user.timezone);
		const localDate = dueAtLocal.toISODate() ?? "";

		let emailAssetEvents: AssetEventsContent | null = null;
		let telegramAssetEvents: AssetEventsContent | null = null;
		let shouldUpdateAnalystMonth = false;

		if (hasAnyAssetEventsOption) {
			const wantsAssetEventsEmail =
				emailEnabled && anyDailyAssetEventFacetEnabled(user.prefs, "email");
			const telegramAssetEventFacets: AssetEventsTelegramFacets = {
				calendar: telegramFacets.has("calendar"),
				ipo: telegramFacets.has("ipo"),
				insider: telegramFacets.has("insider"),
				analyst: telegramFacets.has("analyst"),
			};
			const wantsAssetEventsTelegram =
				telegramEnabled &&
				(telegramAssetEventFacets.calendar ||
					telegramAssetEventFacets.ipo ||
					telegramAssetEventFacets.insider ||
					telegramAssetEventFacets.analyst);

			const assetEventChannels: Array<"email"> = [];
			if (wantsAssetEventsEmail) assetEventChannels.push("email");

			if (assetEventChannels.length > 0 || wantsAssetEventsTelegram) {
				const built = await buildAssetEventsContentForChannels({
					user,
					supabase,
					logger,
					localDate,
					tickers,
					channels: assetEventChannels,
					telegramFacets: wantsAssetEventsTelegram ? telegramAssetEventFacets : undefined,
				});
				emailAssetEvents = built.email;
				telegramAssetEvents = built.telegram;
				shouldUpdateAnalystMonth = built.shouldUpdateAnalystMonth;
			}
		}

		/* =============
		Build email extras
		============= */
		const emailExtras: NotificationExtras | null = emailEnabled
			? {
					news: newsResult?.content ?? null,
					rumors: rumorsResult?.content ?? null,
					predictionMarketsDigest: wantsPredictionMarketsEmail ? predictionMarketsDigest : null,
					analyst: null,
					insider: null,
					topMovers: wantsTopMoversEmail ? topMoversSection : null,
					citations: mergedCitations.length > 0 ? mergedCitations : undefined,
				}
			: null;

		// Telegram extras: prices + top movers + prediction markets when those
		// facets are on. Grok news/rumors are intentionally omitted on Telegram —
		// see the dispatch wiring note. Reuses the rich (email-style) topMovers
		// section already fetched above.
		const telegramExtras: NotificationExtras | null = telegramEnabled
			? {
					news: null,
					rumors: null,
					predictionMarketsDigest: wantsPredictionMarketsTelegram ? predictionMarketsDigest : null,
					analyst: null,
					insider: null,
					topMovers: wantsTopMoversTelegram ? topMoversSection : null,
				}
			: null;

		const emailPriceAssets = includePricesEmail ? userAssets : [];
		const emailPriceMap = includePricesEmail ? assetPrices : new Map();
		const telegramPriceAssets = includePricesTelegram ? userAssets : [];
		const telegramPriceMap = includePricesTelegram ? assetPrices : new Map();
		const hasEmailContent = !!(
			(includePricesEmail && userAssets.length > 0 && emailEnabled) ||
			emailExtras?.news ||
			emailExtras?.rumors ||
			emailExtras?.predictionMarketsDigest ||
			emailExtras?.predictionMarkets ||
			emailExtras?.topMovers ||
			emailAssetEvents?.hasAnyContent
		);
		const hasTelegramContent = !!(
			(includePricesTelegram && userAssets.length > 0) ||
			telegramExtras?.topMovers ||
			telegramExtras?.predictionMarketsDigest ||
			telegramExtras?.predictionMarkets ||
			telegramAssetEvents?.hasAnyContent
		);

		// Shared Telegram date label for both the stage-only render and the live delivery
		// below — defined once so the date format can't drift between the two paths. The
		// market-closed banner is now rendered by formatDailyDigestTelegram itself from raw
		// data (marketClosureInfo + is24 + the Telegram price map).
		const telegramDateLabel = dueAtLocal.isValid
			? dueAtLocal.toFormat("ccc, LLL d")
			: (scheduledDate ?? "");

		if (!hasEmailContent && !hasTelegramContent) {
			logger.info("Skipping daily digest: no content available", {
				action: "daily_run",
				reason: "no_content",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			if (!stageOnly) {
				await updateUserDailyNotificationNextSendAt({
					user,
					supabase,
					logger,
					currentTime,
				});
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
			await stageDailyDigestContent({
				user,
				supabase,
				logger,
				currentTime,
				stats,
				scheduledDate,
				scheduledMinutes,
				dueAtLocal,
				hasEmailContent,
				hasTelegramContent,
				emailExtras,
				telegramExtras,
				emailPriceAssets,
				emailPriceMap,
				telegramPriceAssets,
				telegramPriceMap,
				emailAssetEvents,
				telegramAssetEvents,
				sparklines,
				marketOpen,
				marketClosureInfo,
				getLogoHtml,
				telegramDateLabel,
				delayBannerText,
				grokAllowed,
				hasAnyAssetEventsOption,
				shouldUpdateAnalystMonth,
			});
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
				assetEvents: telegramAssetEvents,
				dateLabel: telegramDateLabel,
				delayBanner: delayBannerText,
				marketClosureInfo,
				is24Hour: user.use_24_hour_time,
				sparklines,
				marketOpen,
				getTelegramSender,
				stats,
			});
		}

		await updateGrokSendCounter(
			user,
			supabase,
			grokAllowed,
			stats.emailsSent > 0 || stats.telegramSent > 0,
			currentTime,
			logger,
			"(daily)",
		);

		/* =============
		Advance next-send-at for daily + asset events (only when delivery is terminal)
		============= */
		const emailRequired = hasEmailContent && emailEnabled;
		const telegramRequired = hasTelegramContent && telegramEnabled;
		const canAdvance = await shouldAdvanceDailyDigestSchedule({
			supabase,
			user,
			scheduledDate,
			scheduledMinutes,
			emailRequired,
			telegramRequired,
		});

		if (canAdvance) {
			await updateUserDailyNotificationNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} else {
			logger.info("Deferring daily digest schedule advance pending delivery retries", {
				action: "daily_run",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				emailRequired,
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
		const scheduleCtxOnError = parseScheduledSlotContext({
			cursorIso: user.daily_notification_next_send_at,
			cursorField: "daily_notification_next_send_at",
			timezone: user.timezone,
			userId: user.id,
			currentTime,
			logger,
			logLabel: " (daily)",
			action: "daily_run",
		});
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
					await updateUserDailyNotificationNextSendAt({
						user,
						supabase,
						logger,
						currentTime,
					});
				} catch (updateError) {
					logger.error(
						"Failed to update daily notification next_send_at after daily digest error",
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
