import { DateTime } from "luxon";
import { generateAddOnsExtrasWithGrok } from "../grok-extras";
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

const GROK_WINDOW_HOURS = 24;
const GROK_MAX_SENDS_PER_WINDOW = 10;

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

		if (!user.add_ons_include_news && !user.add_ons_include_rumors) {
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
			!canInvokeGrokWithinLimit({
				grokWindowStart: user.grok_window_start,
				grokSendsInWindow: user.grok_sends_in_window,
				currentTimeUtc: currentTime,
			})
		) {
			logger.info(
				"Skipping daily add-ons: Grok send limit reached for this window",
				{
					action: "daily_add_ons_run",
					reason: "grok_limit",
					userId: user.id,
					scheduledDate,
					scheduledMinutes,
					grokSendsInWindow: user.grok_sends_in_window,
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

		const extras = await generateAddOnsExtrasWithGrok({
			tickers: userStocks.map((s) => s.symbol),
			localDateIso: scheduledDate,
			timezone: user.timezone,
			includeNews: user.add_ons_include_news,
			includeRumors: user.add_ons_include_rumors,
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

		// Only bump the send counter if at least one delivery succeeded.
		// This way, if delivery fails (e.g. DB issue), the user can adjust
		// their time and get the notification re-sent without burning a send.
		if (stats.emailsSent > 0 || stats.smsSent > 0) {
			const now = currentTime.toISO();
			if (now) {
				// If the window has expired (or never started), reset the counter.
				const windowStart = user.grok_window_start
					? DateTime.fromISO(user.grok_window_start, { zone: "utc" })
					: null;
				const windowExpired =
					!windowStart?.isValid ||
					currentTime.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS;

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
						"Failed to update grok send counter (add-ons)",
						{ userId: user.id, newCount, newWindowStart },
						error,
					);
				}
			}
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
		Best-effort reschedule to avoid retry storms on persistent failures.
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
