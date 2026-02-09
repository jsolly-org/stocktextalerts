import { DateTime } from "luxon";
import {
	fetchWeeklyCalendarData,
	formatEarningsSection,
} from "../finnhub-extras";
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
import type { SmsSenderProvider } from "./run-user-sms-sender";
import {
	processWeeklyCalendarEmailDelivery,
	processWeeklyCalendarSmsDelivery,
} from "./run-user-weekly-delivery";
import { updateUserWeeklyNextSendAt } from "./run-user-weekly-next-send-at";

/**
 * Process a single user's weekly calendar notification.
 *
 * Fetches earnings events for the current week (Mon–Fri) for the user's tracked stocks,
 * formats channel-specific sections, delivers via enabled channels, and advances `weekly_next_send_at`.
 */
export async function processWeeklyUser(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
}): Promise<ScheduledNotificationTotals> {
	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	};
	const { user, supabase, logger, currentTime, sendEmail, getSmsSender } =
		options;

	try {
		const dueAt = user.weekly_next_send_at
			? DateTime.fromISO(user.weekly_next_send_at, { zone: "utc" })
			: currentTime;
		if (!dueAt.isValid) {
			logger.error("Invalid weekly_next_send_at timestamp", {
				userId: user.id,
				weekly_next_send_at: user.weekly_next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error("Failed to format local date for timezone (weekly)", {
				userId: user.id,
				timezone: user.timezone,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error("Failed to format scheduled date (weekly)", {
				userId: user.id,
				timezone: user.timezone,
				weekly_next_send_at: user.weekly_next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error("Failed to calculate scheduled minutes (weekly)", {
				action: "weekly_calendar_run",
				userId: user.id,
				timezone: user.timezone,
				weekly_next_send_at: user.weekly_next_send_at,
				scheduledDate,
			});
			stats.skipped++;
			return stats;
		}

		const hasAnyWeeklyOption =
			user.weekly_include_earnings_email || user.weekly_include_earnings_sms;

		if (!hasAnyWeeklyOption) {
			stats.skipped++;
			await updateUserWeeklyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const userStocks = await loadUserStocks(supabase, user.id);
		const tickers = userStocks.map((s) => s.symbol);

		if (tickers.length === 0) {
			logger.info("Skipping weekly calendar: user has no tracked stocks", {
				action: "weekly_calendar_run",
				reason: "no_stocks",
				userId: user.id,
			});
			stats.skipped++;
			await updateUserWeeklyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const emailEnabled = user.email_notifications_enabled;
		const smsEnabled = shouldSendSms(user);

		if (!emailEnabled && !smsEnabled) {
			stats.skipped++;
			await updateUserWeeklyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		// Determine week range (Monday through Friday of current week)
		const monday = dueAtLocal.startOf("week"); // Luxon weeks start on Monday
		const weekStart = monday.toISODate();
		const weekEnd = monday.plus({ days: 4 }).toISODate();
		if (!weekStart || !weekEnd) {
			logger.error("Failed to compute week range (weekly)", {
				userId: user.id,
				timezone: user.timezone,
			});
			stats.skipped++;
			await updateUserWeeklyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		const calendarData = await fetchWeeklyCalendarData(
			tickers,
			weekStart,
			weekEnd,
		);

		// Format sections per channel
		const emailEarnings =
			emailEnabled && user.weekly_include_earnings_email
				? formatEarningsSection(calendarData.earnings, "email")
				: null;
		const smsEarnings =
			smsEnabled && user.weekly_include_earnings_sms
				? formatEarningsSection(calendarData.earnings, "sms")
				: null;

		const hasEmailContent = !!emailEarnings;
		const hasSmsContent = !!smsEarnings;

		if (!hasEmailContent && !hasSmsContent) {
			logger.info("Skipping weekly calendar: no events this week", {
				action: "weekly_calendar_run",
				reason: "no_content",
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
			});
			stats.skipped++;
			await updateUserWeeklyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
			return stats;
		}

		if (hasEmailContent) {
			await processWeeklyCalendarEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				earningsSection: emailEarnings,
				sendEmail,
				stats,
			});
		}

		if (hasSmsContent) {
			await processWeeklyCalendarSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				earningsSection: smsEarnings,
				getSmsSender,
				stats,
			});
		}

		await updateUserWeeklyNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error(
			"Error processing weekly calendar user",
			{ userId: user.id },
			error,
		);
		try {
			await updateUserWeeklyNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} catch (updateError) {
			logger.error(
				"Failed to update weekly_next_send_at after weekly calendar error",
				{ userId: user.id },
				updateError,
			);
		}
		return stats;
	}
}
