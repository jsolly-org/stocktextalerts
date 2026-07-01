import { DateTime } from "luxon";
import {
	anyDailyAssetEventFacetEnabled,
	enabledDailyNotificationFacets,
	hasAnyDailyAssetEventFacet,
} from "../daily-notification/eligibility";
import { updateUserDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import { loadUserAssets, type UserAssetsMap } from "../db/user-assets";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { buildDelayBannerHtml, buildDelayBannerText } from "../messaging/parts/delay";
import { shouldSendSms } from "../messaging/sms";
import type { SmsSenderFactory } from "../messaging/sms/sender-factory";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { getUsMarketClosureInfoForInstant, type MarketClosureInfo } from "../time/market/calendar";
import { getLocalMinutesFromDateTime } from "../time/schedule/next-send";
import type { UserRecord } from "../types";
import { assertIsoDateString } from "../types";
import { type AssetEventsTelegramFacets, buildAssetEventsContentForChannels } from "./content";
import {
	processAssetEventsEmailDelivery,
	processAssetEventsSmsDelivery,
	processAssetEventsTelegramDelivery,
} from "./delivery";
import { shouldAdvanceAssetEventsSchedule } from "./schedule-state";

/**
 * Process a single user's standalone asset events notification.
 *
 * Builds asset events content (earnings/dividends/splits/IPOs + insider + analyst),
 * delivers via enabled channels, and advances `daily_notification_next_send_at`.
 */
export async function processAssetEventsUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderFactory;
	getTelegramSender: TelegramSenderFactory;
	/** Pre-fetched user assets (avoids N+1 when batch processing). */
	userAssetsMap?: UserAssetsMap;
	/** Prefetched market closure info (avoids per-user API calls when provided). */
	marketClosureInfo?: MarketClosureInfo | null;
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
		userAssetsMap,
		marketClosureInfo: passedMarketClosureInfo,
	} = options;

	try {
		const dueAt = user.daily_notification_next_send_at
			? DateTime.fromISO(user.daily_notification_next_send_at, { zone: "utc" })
			: currentTime;
		if (!dueAt.isValid) {
			logger.error(
				"Invalid daily_notification_next_send_at timestamp",
				{
					userId: user.id,
					daily_notification_next_send_at: user.daily_notification_next_send_at,
				},
				new Error("Invalid daily_notification_next_send_at timestamp"),
			);
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error(
				"Failed to format local date for timezone (asset events)",
				{ userId: user.id, timezone: user.timezone },
				new Error("Failed to format local date for timezone"),
			);
			stats.skipped++;
			return stats;
		}
		const rawScheduledDate = dueAtLocal.toISODate();
		if (!rawScheduledDate) {
			logger.error(
				"Failed to format scheduled date (asset events)",
				{
					userId: user.id,
					timezone: user.timezone,
					daily_notification_next_send_at: user.daily_notification_next_send_at,
				},
				new Error("Failed to format scheduled date"),
			);
			stats.skipped++;
			return stats;
		}
		const scheduledDate = assertIsoDateString(rawScheduledDate);
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error(
				"Failed to calculate scheduled minutes (asset events)",
				{
					action: "asset_events_run",
					userId: user.id,
					timezone: user.timezone,
					daily_notification_next_send_at: user.daily_notification_next_send_at,
					scheduledDate,
				},
				new Error("Failed to calculate scheduled minutes"),
			);
			stats.skipped++;
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

		// All channel facets live in notification_preferences (carried on user.prefs).
		// Telegram additionally gates on the usable-channel check (linked + not opted out).
		const telegramFacetSet = isTelegramChannelUsable(user)
			? enabledDailyNotificationFacets(user.prefs, "telegram")
			: new Set<string>();
		const telegramFacets: AssetEventsTelegramFacets = {
			calendar: telegramFacetSet.has("calendar"),
			ipo: telegramFacetSet.has("ipo"),
			insider: telegramFacetSet.has("insider"),
			analyst: telegramFacetSet.has("analyst"),
		};
		const wantsTelegram =
			telegramFacets.calendar ||
			telegramFacets.ipo ||
			telegramFacets.insider ||
			telegramFacets.analyst;

		const hasAnyAssetEventsOption = hasAnyDailyAssetEventFacet(user.prefs);

		if (!hasAnyAssetEventsOption) {
			stats.skipped++;
			await updateUserDailyNotificationNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const userAssets = userAssetsMap?.get(user.id) ?? (await loadUserAssets(supabase, user.id));
		const tickers = userAssets.map((s) => s.symbol);

		const emailEnabled = user.email_notifications_enabled;
		const smsEnabled = shouldSendSms(user);

		if (!emailEnabled && !smsEnabled && !wantsTelegram) {
			stats.skipped++;
			await updateUserDailyNotificationNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const localDate = dueAtLocal.toISODate() ?? "";

		const marketClosureInfo =
			passedMarketClosureInfo !== undefined
				? passedMarketClosureInfo
				: await getUsMarketClosureInfoForInstant(currentTime);

		const wantsEmail = emailEnabled && anyDailyAssetEventFacetEnabled(user.prefs, "email");
		const wantsSms = smsEnabled && anyDailyAssetEventFacetEnabled(user.prefs, "sms");

		let emailContent: Awaited<ReturnType<typeof buildAssetEventsContentForChannels>>["email"] =
			null;
		let smsContent: Awaited<ReturnType<typeof buildAssetEventsContentForChannels>>["sms"] = null;
		let telegramContent: Awaited<
			ReturnType<typeof buildAssetEventsContentForChannels>
		>["telegram"] = null;
		let shouldUpdateAnalystMonth = false;

		const channels: Array<"email" | "sms"> = [];
		if (wantsEmail) channels.push("email");
		if (wantsSms) channels.push("sms");

		if (channels.length > 0 || wantsTelegram) {
			const built = await buildAssetEventsContentForChannels({
				user,
				supabase,
				logger,
				localDate,
				tickers,
				channels,
				...(wantsTelegram ? { telegramFacets } : {}),
			});
			emailContent = built.email;
			smsContent = built.sms;
			telegramContent = built.telegram;
			shouldUpdateAnalystMonth = built.shouldUpdateAnalystMonth;
		}

		if (wantsEmail && emailContent?.hasAnyContent) {
			await processAssetEventsEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				earningsSection: emailContent.eventsSection?.earnings ?? null,
				dividendsSection: emailContent.eventsSection?.dividends ?? null,
				splitsSection: emailContent.eventsSection?.splits ?? null,
				iposSection: emailContent.eventsSection?.ipos ?? null,
				analystSection: emailContent.analystSection,
				insiderSection: emailContent.insiderSection,
				marketClosureInfo,
				sendEmail,
				stats,
				delayBannerText,
				delayBannerHtml,
			});
		}

		if (wantsSms && smsContent?.hasAnyContent) {
			await processAssetEventsSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				earningsSection: smsContent.eventsSection?.earnings ?? null,
				dividendsSection: smsContent.eventsSection?.dividends ?? null,
				splitsSection: smsContent.eventsSection?.splits ?? null,
				iposSection: smsContent.eventsSection?.ipos ?? null,
				analystSection: smsContent.analystSection,
				insiderSection: smsContent.insiderSection,
				marketClosureInfo,
				getSmsSender,
				stats,
				delayBanner: delayBannerText,
			});
		}

		// Telegram: facet filtering already happened in the content builder — the
		// telegram block only carries sections for the user's Telegram-enabled facets.
		if (wantsTelegram && telegramContent?.hasAnyContent) {
			await processAssetEventsTelegramDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				earningsSection: telegramContent.eventsSection?.earnings ?? null,
				dividendsSection: telegramContent.eventsSection?.dividends ?? null,
				splitsSection: telegramContent.eventsSection?.splits ?? null,
				iposSection: telegramContent.eventsSection?.ipos ?? null,
				analystSection: telegramContent.analystSection,
				insiderSection: telegramContent.insiderSection,
				delayBanner: delayBannerText,
				marketClosureInfo,
				getTelegramSender,
				stats,
			});
		}

		if (shouldUpdateAnalystMonth) {
			const currentMonth = localDate.slice(0, 7); // YYYY-MM
			const { error } = await supabase
				.from("users")
				.update({ asset_events_last_analyst_sent_month: currentMonth })
				.eq("id", user.id);
			if (error) {
				logger.error(
					"Failed to update asset_events_last_analyst_sent_month",
					{ userId: user.id, currentMonth },
					error,
				);
			}
		}

		const emailRequired = wantsEmail && Boolean(emailContent?.hasAnyContent);
		const smsRequired = wantsSms && Boolean(smsContent?.hasAnyContent);
		const telegramRequired = wantsTelegram && Boolean(telegramContent?.hasAnyContent);
		const canAdvance = await shouldAdvanceAssetEventsSchedule({
			supabase,
			user,
			scheduledDate,
			scheduledMinutes,
			emailRequired,
			smsRequired,
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
			logger.info("Deferring asset events schedule advance pending delivery retries", {
				action: "asset_events_run",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				emailRequired,
				smsRequired,
				telegramRequired,
			});
		}

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing asset events user", { userId: user.id }, error);
		return stats;
	}
}
