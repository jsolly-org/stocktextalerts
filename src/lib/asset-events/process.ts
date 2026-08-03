import type { DateTime } from "luxon";
import {
	anyDailyAssetEventFacetEnabled,
	hasAnyDailyAssetEventFacet,
} from "../daily-notification/eligibility";
import { updateUserDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import { loadUserAssets, type UserAssetsMap } from "../db/user-assets";
import type { Logger } from "../logging";
import { resolveOutboundChannel } from "../messaging/delivery-channel";
import { buildDelayBannerHtml, buildDelayBannerText } from "../messaging/parts/delay";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender } from "../messaging/types";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { getUsMarketClosureInfoForInstant } from "../time/market/calendar";
import { parseScheduledSlotContext } from "../time/schedule/next-send";
import type { MarketClosureInfo } from "../time/types";
import type { UserRecord } from "../types";
import { buildAssetEventsContent } from "./content";
import { processAssetEventsEmailDelivery, processAssetEventsTelegramDelivery } from "./delivery";
import { shouldAdvanceAssetEventsSchedule } from "./schedule-state";

/**
 * Process a single user's standalone asset events notification.
 *
 * Builds asset events content (earnings/dividends/splits/IPOs + insider + analyst),
 * delivers on the account's single `delivery_channel`, and advances
 * `daily_notification_next_send_at`.
 */
export async function processAssetEventsUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
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
		userAssetsMap,
		marketClosureInfo: passedMarketClosureInfo,
	} = options;

	try {
		const slotCtx = parseScheduledSlotContext({
			cursorIso: user.daily_notification_next_send_at,
			cursorField: "daily_notification_next_send_at",
			timezone: user.timezone,
			userId: user.id,
			currentTime,
			logger,
			logLabel: " (asset events)",
			action: "asset_events_run",
		});
		if (!slotCtx) {
			stats.skipped++;
			return stats;
		}
		const { scheduledDate, scheduledMinutes, dueAt } = slotCtx;

		const delayBannerOpts = {
			scheduledFor: dueAt,
			now: currentTime,
			userTimezone: user.timezone,
			use24Hour: user.use_24_hour_time,
		};
		const delayBannerText = buildDelayBannerText(delayBannerOpts);
		const delayBannerHtml = buildDelayBannerHtml(delayBannerOpts);

		const outbound = resolveOutboundChannel(user);
		const hasAnyAssetEventsOption = hasAnyDailyAssetEventFacet(user.prefs);
		const contentEnabled = anyDailyAssetEventFacetEnabled(user.prefs);

		if (!hasAnyAssetEventsOption || !outbound || !contentEnabled) {
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

		const localDate = scheduledDate;

		const marketClosureInfo =
			passedMarketClosureInfo !== undefined
				? passedMarketClosureInfo
				: await getUsMarketClosureInfoForInstant(currentTime);

		const built = await buildAssetEventsContent({
			user,
			supabase,
			logger,
			localDate,
			tickers,
		});
		const content = built.content;
		const shouldUpdateAnalystMonth = built.shouldUpdateAnalystMonth;

		if (outbound === "email" && content.hasAnyContent) {
			await processAssetEventsEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				earningsSection: content.eventsSection?.earnings ?? null,
				dividendsSection: content.eventsSection?.dividends ?? null,
				splitsSection: content.eventsSection?.splits ?? null,
				iposSection: content.eventsSection?.ipos ?? null,
				analystSection: content.analystSection,
				insiderSection: content.insiderSection,
				filingsLines: content.filingsLines,
				shortInterest: content.shortInterest,
				marketClosureInfo,
				sendEmail,
				stats,
				delayBannerText,
				delayBannerHtml,
			});
		}

		if (outbound === "telegram" && content.hasAnyContent) {
			await processAssetEventsTelegramDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				earningsSection: content.eventsSection?.earnings ?? null,
				dividendsSection: content.eventsSection?.dividends ?? null,
				splitsSection: content.eventsSection?.splits ?? null,
				iposSection: content.eventsSection?.ipos ?? null,
				analystSection: content.analystSection,
				insiderSection: content.insiderSection,
				filingsLines: content.filingsLines,
				shortInterest: content.shortInterest,
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

		const requiredChannel = content.hasAnyContent ? outbound : null;
		const canAdvance = await shouldAdvanceAssetEventsSchedule({
			supabase,
			user,
			scheduledDate,
			scheduledMinutes,
			requiredChannel,
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
				requiredChannel,
			});
		}

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing asset events user", { userId: user.id }, error);
		return stats;
	}
}
