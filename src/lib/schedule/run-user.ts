import { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { shouldSendSms } from "../messaging/sms";
import type { UserRecord, UserStockRow } from "../messaging/types";
import { getLocalMinutesFromDateTime } from "../time/digest-times";
import type {
	DeliveryMethod,
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { loadUserStocks } from "./helpers";
import {
	processScheduledUserEmailDelivery,
	processScheduledUserSmsDelivery,
} from "./run-user-delivery";
import { updateUserNextSendAt } from "./run-user-next-send-at";
import type { SmsSenderProvider } from "./run-user-sms-sender";

function buildStocksList(userStocks: UserStockRow[]): string {
	if (userStocks.length === 0) {
		return "You don't have any tracked stocks";
	}

	return userStocks
		.map((stock) => `${stock.symbol} - ${stock.name}`)
		.join(", ");
}

export async function processScheduledUser(options: {
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
	let attemptedDeliveryMethod: DeliveryMethod | null = null;
	const { user, supabase, logger, sendEmail, currentTime, getSmsSender } =
		options;

	try {
		// Query filters out null next_send_at with .not("next_send_at", "is", null)
		const dueAt = DateTime.fromISO(user.next_send_at as string, {
			zone: "utc",
		});
		if (!dueAt.isValid) {
			logger.error("Invalid next_send_at timestamp", {
				userId: user.id,
				next_send_at: user.next_send_at,
			});
			stats.skipped++;
			return stats;
		}
		const dueAtLocal = dueAt.setZone(user.timezone);
		if (!dueAtLocal.isValid) {
			logger.error("Failed to format local date for timezone", {
				userId: user.id,
				timezone: user.timezone,
			});
			stats.skipped++;
			return stats;
		}
		const scheduledDate = dueAtLocal.toISODate();
		if (!scheduledDate) {
			logger.error("Failed to format scheduled date", {
				userId: user.id,
				timezone: user.timezone,
				next_send_at: user.next_send_at,
				dueAt: dueAt.toISO(),
				dueAtLocalIso: dueAtLocal.toISO(),
			});
			stats.skipped++;
			return stats;
		}
		const scheduledMinutes = getLocalMinutesFromDateTime(user.timezone, dueAt);
		if (scheduledMinutes === null) {
			logger.error("Failed to calculate scheduled minutes", {
				action: "scheduled_notifications_run",
				phase: "getLocalMinutesFromDateTime",
				userId: user.id,
				timezone: user.timezone,
				next_send_at: user.next_send_at,
				dueAt: dueAt.toISO(),
				dueAtLocalIso: dueAtLocal.toISO(),
				scheduledDate,
			});
			stats.skipped++;
			return stats;
		}

		const userStocks = await loadUserStocks(supabase, user.id);
		const stocksList = buildStocksList(userStocks);

		// Process Email
		if (user.email_notifications_enabled) {
			attemptedDeliveryMethod = "email";
			await processScheduledUserEmailDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				stocksList,
				sendEmail,
				stats,
			});
		}

		// Process SMS
		if (shouldSendSms(user)) {
			attemptedDeliveryMethod = "sms";
			await processScheduledUserSmsDelivery({
				user,
				supabase,
				logger,
				scheduledDate,
				scheduledMinutes,
				userStocks,
				stocksList,
				getSmsSender,
				stats,
			});
		}

		await updateUserNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing user", { userId: user.id }, error);

		try {
			const deliveryMethod: DeliveryMethod =
				attemptedDeliveryMethod ??
				(user.email_notifications_enabled ? "email" : "sms");
			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "scheduled_update",
				delivery_method: deliveryMethod,
				message_delivered: false,
				message: "Error processing notification",
				error: error instanceof Error ? error.message : String(error),
			});
			if (!logged) {
				stats.logFailures++;
			}
		} catch (logError) {
			logger.error(
				"Failed to record notification for user",
				{ userId: user.id },
				logError,
			);
			stats.logFailures++;
		}

		return stats;
	}
}
