import { DateTime } from "luxon";
import type { Logger } from "../../logging";
import { createErrorForLogging, extractErrorMessage } from "../../logging/errors";
import { formatAssetsTextList } from "../../messaging/asset-formatting";
import { buildDelayBannerHtml, buildDelayBannerText } from "../../messaging/delay-banner";
import type { EmailSender } from "../../messaging/email/utils";
import { type LogoCache, safePrefetchLogos } from "../../messaging/logo-fetcher";
import { buildMarketClosedBannerText } from "../../messaging/market-closure-banner";
import { anyFacetEnabled, isFacetEnabled } from "../../messaging/notification-prefs";
import { recordNotification } from "../../messaging/shared";
import { shouldSendSms } from "../../messaging/sms";
import type { SmsSenderFactory } from "../../messaging/sms/sender-factory";
import type { SparklineMap } from "../../messaging/sparkline";
import { isTelegramChannelUsable } from "../../messaging/telegram/eligibility";
import type { TelegramSenderFactory } from "../../messaging/telegram/sender-factory";
import type { UserRecord } from "../../messaging/types";
import type {
	DeliveryMethod,
	ScheduledNotificationTotals,
	SupabaseAdminClient,
	UserAssetsMap,
} from "../../schedule/helpers";
import { loadUserAssets } from "../../schedule/helpers";
import { isOutsideMarketHours, userLocalToEtMinute } from "../../time/format";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { getUsMarketClosureInfoForInstant } from "../../time/market-calendar";
import { getLocalMinutesFromDateTime } from "../../time/scheduled-times";
import type { AssetPriceMap, MarketSession } from "../../vendors/price-fetcher";
import { fetchIntradaySparklines, NO_SESSION_TRADE } from "../../vendors/price-fetcher";
import {
	processMarketScheduledEmailDelivery,
	processMarketScheduledSmsDelivery,
	processMarketScheduledTelegramDelivery,
} from "./delivery";
import { updateUserMarketScheduledNextSendAt } from "./next-send-at";
import { shouldAdvanceMarketScheduledSchedule } from "./schedule-state";
import { buildSessionFirstLine } from "./session-label";

/** Process a single user's scheduled market asset update notification. */
export async function processMarketScheduledUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderFactory;
	getTelegramSender: TelegramSenderFactory;
	priceMap: AssetPriceMap;
	/** Symbols Massive recognized but had no live trade in the current session.
	 *  The renderer emits "no pre-market trades" / "no after-hours trades" for
	 *  these (vs. the generic "price unavailable" used for fetch misses). */
	noSessionTrade?: Set<string>;
	marketSession: MarketSession;
	/** Market closure info for banner when session is "closed". */
	marketClosureInfo?: MarketClosureInfo | null;
	/** Pre-fetched user assets (avoids N+1 when batch processing). */
	userAssetsMap?: UserAssetsMap;
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
	let attemptedDeliveryMethod: DeliveryMethod | null = null;
	const {
		user,
		supabase,
		logger,
		sendEmail,
		currentTime,
		getSmsSender,
		getTelegramSender,
		priceMap,
		noSessionTrade,
		marketSession,
		marketClosureInfo,
		userAssetsMap,
	} = options;

	// Skip when no active session — session resolution happens at delivery time
	// so off-hours users (closed market) advance their schedule without sending.
	if (marketSession === "closed") {
		logger.info("Skipping scheduled market delivery — no active session", {
			userId: user.id,
			scheduledEtMinutes: user.market_scheduled_asset_price_times,
			dueAt: user.market_scheduled_asset_price_next_send_at,
		});
		stats.skipped++;
		// Defensive try/catch: a transient failure advancing next_send_at
		// (e.g., calculateNextMarketScheduledSendAtFromTimes throwing on malformed
		// data) should not abort the entire batch via Promise.all rejection.
		try {
			await updateUserMarketScheduledNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} catch (error) {
			logger.error(
				"Failed to advance market_scheduled_asset_price_next_send_at after closed-session skip",
				{ userId: user.id },
				createErrorForLogging(error),
			);
		}
		return stats;
	}

	try {
		/* =============
		Cron vs manual schedule anchoring
		Normal cron only processes users with market_scheduled_asset_price_next_send_at set; manual sends (--force)
		may include users without market_scheduled_asset_price_next_send_at (e.g. newly enabled scheduled updates). In that case,
		use "now" as the schedule anchor.
		============= */
		const dueAt = user.market_scheduled_asset_price_next_send_at
			? DateTime.fromISO(user.market_scheduled_asset_price_next_send_at, {
					zone: "utc",
				})
			: currentTime;
		if (!dueAt.isValid) {
			logger.error(
				"Invalid market_scheduled_asset_price_next_send_at timestamp",
				{
					userId: user.id,
					market_scheduled_asset_price_next_send_at: user.market_scheduled_asset_price_next_send_at,
				},
				new Error("Invalid market_scheduled_asset_price_next_send_at timestamp"),
			);
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error(
				"Failed to format local date for timezone",
				{ userId: user.id, timezone: user.timezone },
				new Error("Failed to format local date for timezone"),
			);
			stats.skipped++;
			return stats;
		}
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error(
				"Failed to format scheduled date",
				{
					userId: user.id,
					timezone: user.timezone,
					market_scheduled_asset_price_next_send_at: user.market_scheduled_asset_price_next_send_at,
					dueAt: dueAt.toISO(),
					dueAtLocalIso: dueAtLocal.toISO(),
				},
				new Error("Failed to format scheduled date"),
			);
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error(
				"Failed to calculate scheduled minutes",
				{
					action: "market_notifications_run",
					phase: "getLocalMinutesFromDateTime",
					userId: user.id,
					timezone: user.timezone,
					market_scheduled_asset_price_next_send_at: user.market_scheduled_asset_price_next_send_at,
					dueAt: dueAt.toISO(),
					dueAtLocalIso: dueAtLocal.toISO(),
					scheduledDate,
				},
				new Error("Failed to calculate scheduled minutes"),
			);
			stats.skipped++;
			return stats;
		}
		const marketClosure = await getUsMarketClosureInfoForInstant(dueAt);
		if (marketClosure) {
			logger.info("Skipping scheduled market delivery for closed market date", {
				userId: user.id,
				reason: marketClosure.reason,
				dueAt: dueAt.toISO(),
			});
			stats.skipped++;
			await updateUserMarketScheduledNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		/* ============= Guard: skip if scheduled time is outside market hours
		(can happen when a DST shift makes a previously-valid local time
		fall outside the 4:30 AM – 7:30 PM ET extended-hours window) ============= */
		if (isOutsideMarketHours(userLocalToEtMinute(scheduledMinutes, user.timezone))) {
			logger.info(
				"Skipping scheduled market delivery — time outside market hours (possible DST drift)",
				{
					userId: user.id,
					scheduledMinutes,
					timezone: user.timezone,
					dueAt: dueAt.toISO(),
				},
			);
			stats.skipped++;
			await updateUserMarketScheduledNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const delayBannerOpts = {
			scheduledFor: dueAt,
			now: currentTime,
			userTimezone: user.timezone,
			use24Hour: user.use_24_hour_time,
		};
		const delayBannerText = buildDelayBannerText(delayBannerOpts);
		const delayBannerHtml = buildDelayBannerHtml(delayBannerOpts);

		const userAssets =
			userAssetsMap?.get(user.id) ??
			(await loadUserAssets(supabase, user.id, { includeLogoData: true }));
		const tickers = userAssets.map((a) => a.symbol);
		// All active sessions (pre/regular/after) use the same intraday-since-prev-close
		// sparkline so the chart's first-to-last delta equals the prev-close-anchored
		// headline change-% — keeping shape, color, and headline % in lockstep.
		// Massive's 5-minute bars endpoint returns extended-hours data, so the
		// pre-market chart includes 4:00 AM ET onward.
		const prevCloseMap = new Map<string, number | null | undefined>();
		const currentPriceMap = new Map<string, number | null | undefined>();
		for (const [symbol, quote] of priceMap) {
			if (quote) {
				prevCloseMap.set(symbol, quote.prevClose);
				currentPriceMap.set(symbol, quote.price);
			}
		}
		let sparklines: SparklineMap = new Map();
		if (tickers.length > 0) {
			try {
				sparklines = await fetchIntradaySparklines(tickers, prevCloseMap, currentPriceMap, {
					supabase,
					timezone: user.timezone,
					use24HourTime: user.use_24_hour_time,
				});
			} catch (error) {
				logger.error(
					"Failed to fetch sparklines for scheduled market notification",
					{
						action: "market_notifications_run",
						userId: user.id,
						tickerCount: tickers.length,
						marketSession,
						sparklineWindow: "intraday-since-prev-close",
					},
					createErrorForLogging(error),
				);
			}
		}
		const getSparkline = (symbol: string) => sparklines.get(symbol) ?? null;

		const scheduledIncludeEmail = isFacetEnabled(
			user.prefs,
			"market_scheduled_asset_price",
			"email",
		);
		const scheduledIncludeSms = isFacetEnabled(user.prefs, "market_scheduled_asset_price", "sms");
		const shouldPrepareEmail = user.email_notifications_enabled && scheduledIncludeEmail;
		const { getLogoHtml } = await safePrefetchLogos({
			assets: userAssets,
			shouldPrefetch: shouldPrepareEmail,
			supabase,
			logger,
			logContext: { action: "market_notifications_run", userId: user.id },
			cache: options.logoCache,
		});

		// Past the early return, the session is always pre/regular/after — show change%.
		const getPrice = (symbol: string) =>
			noSessionTrade?.has(symbol) ? NO_SESSION_TRADE : (priceMap.get(symbol) ?? undefined);
		const assetsList = formatAssetsTextList(
			userAssets,
			getPrice,
			getSparkline,
			true,
			marketSession,
		);

		const shouldAttemptSms = shouldSendSms(user);

		// All channel preferences (incl. Telegram) live in notification_preferences,
		// carried on user.prefs. Telegram gates on the usable-channel check + facet row.
		const telegramEnabled =
			isTelegramChannelUsable(user) &&
			anyFacetEnabled(user.prefs, "market_scheduled_asset_price", "telegram");

		const sessionFirstLine = {
			scheduledEtMinutes: userLocalToEtMinute(scheduledMinutes, user.timezone),
			is24: user.use_24_hour_time,
		};

		/* ============= Process Email ============= */
		if (user.email_notifications_enabled && scheduledIncludeEmail) {
			attemptedDeliveryMethod = "email";
			await processMarketScheduledEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetsList,
				sendEmail,
				priceMap,
				noSessionTrade,
				marketSession,
				marketClosureInfo,
				stats,
				getSparkline,
				getLogoHtml,
				delayBanners: {
					text: delayBannerText,
					html: delayBannerHtml,
				},
				sessionFirstLine,
			});
		}

		/* ============= Process SMS ============= */
		if (shouldAttemptSms && scheduledIncludeSms) {
			attemptedDeliveryMethod = "sms";
			await processMarketScheduledSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				assetsList,
				getSmsSender,
				marketSession,
				marketClosureInfo,
				stats,
				delayBanner: delayBannerText,
				sessionFirstLine,
			});
		}

		/* ============= Process Telegram ============= */
		if (telegramEnabled) {
			attemptedDeliveryMethod = "telegram";
			const sessionLabel = buildSessionFirstLine(
				marketSession,
				sessionFirstLine.scheduledEtMinutes,
				sessionFirstLine.is24,
			);
			const telegramMarketBanner = marketClosureInfo
				? buildMarketClosedBannerText(marketClosureInfo)
				: null;
			await processMarketScheduledTelegramDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userAssets,
				priceMap,
				sessionLabel,
				delayBanner: delayBannerText,
				marketClosedBanner: telegramMarketBanner,
				getTelegramSender,
				stats,
			});
		}

		const emailRequired = user.email_notifications_enabled && scheduledIncludeEmail;
		const smsRequired = shouldAttemptSms && scheduledIncludeSms;
		const telegramRequired = telegramEnabled;
		const canAdvance = await shouldAdvanceMarketScheduledSchedule({
			supabase,
			user,
			scheduledDate,
			scheduledMinutes,
			emailRequired,
			smsRequired,
			telegramRequired,
		});

		if (canAdvance) {
			await updateUserMarketScheduledNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} else {
			logger.info("Deferring market schedule advance pending delivery retries", {
				action: "market_notifications_run",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				emailRequired,
				smsRequired,
			});
		}

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing user", { userId: user.id }, error);

		try {
			const deliveryAttempts =
				stats.emailsSent +
				stats.emailsFailed +
				stats.smsSent +
				stats.smsFailed +
				stats.telegramSent +
				stats.telegramFailed;

			// Avoid false negatives: if delivery already happened (or was at least recorded as
			// attempted) on ANY channel — including Telegram — a later failure (e.g. updating
			// market_scheduled_asset_price_next_send_at) shouldn't log as undelivered.
			if (deliveryAttempts === 0) {
				const shouldAttemptSms = shouldSendSms(user);
				const eligibleEmail =
					user.email_notifications_enabled &&
					isFacetEnabled(user.prefs, "market_scheduled_asset_price", "email");
				const eligibleSms =
					shouldAttemptSms && isFacetEnabled(user.prefs, "market_scheduled_asset_price", "sms");

				const deliveryMethod: DeliveryMethod =
					attemptedDeliveryMethod ??
					(eligibleEmail
						? "email"
						: eligibleSms
							? "sms"
							: user.email_notifications_enabled
								? "email"
								: "sms");
				const logged = await recordNotification(supabase, {
					user_id: user.id,
					type: "market",
					delivery_method: deliveryMethod,
					message_delivered: false,
					message: "Error processing notification",
					error: extractErrorMessage(error),
				});
				if (!logged) {
					stats.logFailures++;
				}
			}
		} catch (logError) {
			logger.error("Failed to record notification for user", { userId: user.id }, logError);
			stats.logFailures++;
		}

		return stats;
	}
}
