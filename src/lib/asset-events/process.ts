import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { buildDelayBannerHtml, buildDelayBannerText } from "../messaging/delay-banner";
import type { EmailSender } from "../messaging/email/utils";
import { shouldSendSms } from "../messaging/sms";
import type { UserRecord } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
	UserAssetsMap,
} from "../schedule/helpers";
import { loadUserAssets } from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import { getUsMarketClosureInfoForInstant, type MarketClosureInfo } from "../time/market-calendar";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import { buildAssetEventsContentForChannels } from "./content";
import { processAssetEventsEmailDelivery, processAssetEventsSmsDelivery } from "./delivery";
import { updateUserAssetEventsNextSendAt } from "./next-send-at";
import { shouldAdvanceAssetEventsSchedule } from "./schedule-state";

/**
 * Process a single user's standalone asset events notification.
 *
 * Builds asset events content (earnings/dividends/splits/IPOs + insider + analyst),
 * delivers via enabled channels, and advances `asset_events_next_send_at`.
 */
export async function processAssetEventsUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
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
	};
	const {
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		userAssetsMap,
		marketClosureInfo: passedMarketClosureInfo,
	} = options;

	try {
		const dueAt = user.asset_events_next_send_at
			? DateTime.fromISO(user.asset_events_next_send_at, { zone: "utc" })
			: currentTime;
		if (!dueAt.isValid) {
			logger.error(
				"Invalid asset_events_next_send_at timestamp",
				{
					userId: user.id,
					asset_events_next_send_at: user.asset_events_next_send_at,
				},
				new Error("Invalid asset_events_next_send_at timestamp"),
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
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error(
				"Failed to format scheduled date (asset events)",
				{
					userId: user.id,
					timezone: user.timezone,
					asset_events_next_send_at: user.asset_events_next_send_at,
				},
				new Error("Failed to format scheduled date"),
			);
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error(
				"Failed to calculate scheduled minutes (asset events)",
				{
					action: "asset_events_run",
					userId: user.id,
					timezone: user.timezone,
					asset_events_next_send_at: user.asset_events_next_send_at,
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

		const hasAnyAssetEventsOption =
			user.asset_events_include_calendar_email ||
			user.asset_events_include_calendar_sms ||
			user.asset_events_include_ipo_email ||
			user.asset_events_include_ipo_sms ||
			user.asset_events_include_analyst_email ||
			user.asset_events_include_analyst_sms ||
			user.asset_events_include_insider_email ||
			user.asset_events_include_insider_sms;

		if (!hasAnyAssetEventsOption) {
			stats.skipped++;
			await updateUserAssetEventsNextSendAt({
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

		if (!emailEnabled && !smsEnabled) {
			stats.skipped++;
			await updateUserAssetEventsNextSendAt({
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

		const wantsEmail =
			emailEnabled &&
			(user.asset_events_include_calendar_email ||
				user.asset_events_include_ipo_email ||
				user.asset_events_include_analyst_email ||
				user.asset_events_include_insider_email);
		const wantsSms =
			smsEnabled &&
			(user.asset_events_include_calendar_sms ||
				user.asset_events_include_ipo_sms ||
				user.asset_events_include_analyst_sms ||
				user.asset_events_include_insider_sms);

		let emailContent: Awaited<ReturnType<typeof buildAssetEventsContentForChannels>>["email"] =
			null;
		let smsContent: Awaited<ReturnType<typeof buildAssetEventsContentForChannels>>["sms"] = null;
		let shouldUpdateAnalystMonth = false;

		const channels: Array<"email" | "sms"> = [];
		if (wantsEmail) channels.push("email");
		if (wantsSms) channels.push("sms");

		if (channels.length > 0) {
			const built = await buildAssetEventsContentForChannels({
				user,
				supabase,
				logger,
				localDate,
				tickers,
				channels,
			});
			emailContent = built.email;
			smsContent = built.sms;
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
		const canAdvance = await shouldAdvanceAssetEventsSchedule({
			supabase,
			user,
			scheduledDate,
			scheduledMinutes,
			emailRequired,
			smsRequired,
		});

		if (canAdvance) {
			await updateUserAssetEventsNextSendAt({
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
			});
		}

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing asset events user", { userId: user.id }, error);
		return stats;
	}
}
