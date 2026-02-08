import { DateTime } from "luxon";
import { generateFirstNotificationExtrasWithGrok } from "../grok-extras";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { shouldSendSms } from "../messaging/sms";
import type { UserRecord } from "../messaging/types";
import { getLocalMinutesFromDateTime } from "../time/scheduled-times";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { loadUserStocks } from "./helpers";
import {
	processDailyAddOnsEmailDelivery,
	processDailyAddOnsSmsDelivery,
} from "./run-user-add-ons-delivery";
import { updateUserAddOnsNextSendAt } from "./run-user-add-ons-next-send-at";
import type { SmsSenderProvider } from "./run-user-sms-sender";

function canInvokeGrokWithinWindow(options: {
	lastInvokedAtIso: string | null;
	currentTimeUtc: DateTime;
	windowHours: number;
}): boolean {
	if (!options.lastInvokedAtIso) {
		return true;
	}
	const last = DateTime.fromISO(options.lastInvokedAtIso, { zone: "utc" });
	if (!last.isValid) {
		return true;
	}
	return (
		options.currentTimeUtc.diff(last, "hours").hours >= options.windowHours
	);
}

export async function processDailyAddOnsUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	marketOpen: boolean;
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
		marketOpen,
	} = options;

	try {
		const dueAt = user.add_ons_next_send_at
			? DateTime.fromISO(user.add_ons_next_send_at, { zone: "utc" })
			: currentTime;
		if (!dueAt.isValid) {
			logger.error("Invalid add_ons_next_send_at timestamp", {
				userId: user.id,
				add_ons_next_send_at: user.add_ons_next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error("Failed to format local date for timezone (add-ons)", {
				userId: user.id,
				timezone: user.timezone,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error("Failed to format scheduled date (add-ons)", {
				userId: user.id,
				timezone: user.timezone,
				add_ons_next_send_at: user.add_ons_next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error("Failed to calculate scheduled minutes (add-ons)", {
				action: "daily_add_ons_run",
				userId: user.id,
				timezone: user.timezone,
				add_ons_next_send_at: user.add_ons_next_send_at,
				scheduledDate,
			});
			stats.skipped++;
			return stats;
		}

		if (user.add_ons_only_notify_when_market_open && !marketOpen) {
			logger.info("Skipping daily add-ons notification: market is closed", {
				action: "daily_add_ons_run",
				reason: "market_closed",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			await updateUserAddOnsNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		if (
			!user.first_notification_include_news &&
			!user.first_notification_include_rumors
		) {
			stats.skipped++;
			await updateUserAddOnsNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const userStocks = await loadUserStocks(supabase, user.id);

		if (
			!canInvokeGrokWithinWindow({
				lastInvokedAtIso: user.last_grok_rumors_at,
				currentTimeUtc: currentTime,
				windowHours: 24,
			})
		) {
			logger.info(
				"Skipping daily add-ons: Grok extras already generated recently",
				{
					action: "daily_add_ons_run",
					reason: "grok_gate",
					userId: user.id,
					scheduledDate,
					scheduledMinutes,
				},
			);
			stats.skipped++;
			await updateUserAddOnsNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const extras = await generateFirstNotificationExtrasWithGrok({
			tickers: userStocks.map((s) => s.symbol),
			localDateIso: scheduledDate,
			timezone: user.timezone,
			includeNews: user.first_notification_include_news,
			includeRumors: user.first_notification_include_rumors,
		});

		if (!extras?.news && !extras?.rumors) {
			logger.info("Skipping daily add-ons: no content available", {
				action: "daily_add_ons_run",
				reason: "no_content",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			await updateUserAddOnsNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const invokedAt = currentTime.toISO();
		if (invokedAt) {
			user.last_grok_rumors_at = invokedAt;
			const { error } = await supabase
				.from("users")
				.update({ last_grok_rumors_at: invokedAt })
				.eq("id", user.id);
			if (error) {
				logger.error(
					"Failed to update last_grok_rumors_at (add-ons)",
					{ userId: user.id, invokedAt },
					error,
				);
			}
		}

		if (user.email_notifications_enabled) {
			await processDailyAddOnsEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				extras,
				sendEmail,
				stats,
			});
		}

		if (shouldSendSms(user)) {
			await processDailyAddOnsSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				extras,
				getSmsSender,
				stats,
			});
		}

		await updateUserAddOnsNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error(
			"Error processing daily add-ons user",
			{ userId: user.id },
			error,
		);
		/* =============
		Best-effort reschedule to avoid retry storms on persistent failures
		============= */
		try {
			await updateUserAddOnsNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} catch (updateError) {
			logger.error(
				"Failed to update add_ons_next_send_at after daily add-ons error",
				{ userId: user.id },
				updateError,
			);
		}
		return stats;
	}
}
