import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { processEmailUpdate } from "../messaging/email/delivery";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { shouldSendSms } from "../messaging/sms";
import { processSmsUpdate } from "../messaging/sms/delivery";
import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "../messaging/sms/twilio-utils";
import type { UserRecord, UserStockRow } from "../messaging/types";
import {
	calculateNextSendAtFromTimes,
	getLocalMinutesFromDateTime,
} from "../time/digest-times";
import type {
	DeliveryMethod,
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import {
	loadUserStocks,
	logRetriesExhausted,
	updateScheduledNotificationRow,
} from "./helpers";

interface SmsSenderResult {
	sender: ReturnType<typeof createSmsSender> | null;
	error?: string;
}

type SmsSenderProvider = () => SmsSenderResult;

export function createSmsSenderProvider(logger: Logger): SmsSenderProvider {
	let twilioConfig: ReturnType<typeof readTwilioConfig> | null = null;
	let sendSms: ReturnType<typeof createSmsSender> | null = null;

	return () => {
		if (sendSms) {
			return { sender: sendSms };
		}

		try {
			if (!twilioConfig) {
				twilioConfig = readTwilioConfig();
			}
			const twilioClient = createTwilioClient(twilioConfig);
			sendSms = createSmsSender(twilioClient, twilioConfig.phoneNumber);
			return { sender: sendSms };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(
				"Failed to initialize Twilio client",
				{
					phase: "initTwilio",
					errorMessage: errorMsg,
					phoneNumber: twilioConfig?.phoneNumber,
				},
				error,
			);
			return { sender: null, error: errorMsg };
		}
	};
}

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
			const { data: claimed, error: claimError } = await supabase.rpc(
				"claim_scheduled_notification",
				{
					p_user_id: user.id,
					p_notification_type: "daily_digest",
					p_scheduled_date: scheduledDate,
					p_scheduled_minutes: scheduledMinutes,
					p_channel: "email",
				},
			);

			if (claimError) {
				logger.error(
					"Failed to claim scheduled notification (email)",
					{ userId: user.id },
					claimError,
				);
				stats.emailsFailed++;
			} else if (!claimed) {
				await logRetriesExhausted({
					supabase,
					userId: user.id,
					notificationType: "daily_digest",
					scheduledDate,
					scheduledMinutes,
					channel: "email",
					logger,
				});
				stats.skipped++;
			} else {
				const emailIdempotencyKey = `daily-digest/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
				const { sent, logged, error } = await processEmailUpdate(
					supabase,
					user,
					userStocks,
					stocksList,
					sendEmail,
					emailIdempotencyKey,
				);

				if (sent) {
					stats.emailsSent++;
				} else {
					stats.emailsFailed++;
				}

				if (!logged) {
					stats.logFailures++;
				}

				await updateScheduledNotificationRow({
					supabase,
					userId: user.id,
					notificationType: "daily_digest",
					scheduledDate,
					scheduledMinutes,
					channel: "email",
					status: sent ? "sent" : "failed",
					error,
					logger,
				});
			}
		}

		// Process SMS
		if (shouldSendSms(user)) {
			attemptedDeliveryMethod = "sms";
			const { data: claimed, error: claimError } = await supabase.rpc(
				"claim_scheduled_notification",
				{
					p_user_id: user.id,
					p_notification_type: "daily_digest",
					p_scheduled_date: scheduledDate,
					p_scheduled_minutes: scheduledMinutes,
					p_channel: "sms",
				},
			);

			if (claimError) {
				logger.error(
					"Failed to claim scheduled notification (sms)",
					{ userId: user.id },
					claimError,
				);
				stats.smsFailed++;
			} else if (!claimed) {
				await logRetriesExhausted({
					supabase,
					userId: user.id,
					notificationType: "daily_digest",
					scheduledDate,
					scheduledMinutes,
					channel: "sms",
					logger,
				});
				stats.skipped++;
			} else {
				const { sender: smsSender, error: smsError } = getSmsSender();
				if (!smsSender) {
					stats.smsFailed++;
					await updateScheduledNotificationRow({
						supabase,
						userId: user.id,
						notificationType: "daily_digest",
						scheduledDate,
						scheduledMinutes,
						channel: "sms",
						status: "failed",
						error: smsError || "Twilio client not initialized",
						logger,
					});
					const logged = await recordNotification(supabase, {
						user_id: user.id,
						type: "scheduled_update",
						delivery_method: "sms",
						message_delivered: false,
						message: "SMS service unavailable",
						error: smsError || "Twilio client not initialized",
					});
					if (!logged) {
						stats.logFailures++;
					}
					// Continue to next_send_at calculation/update so this user
					// doesn't get stuck retrying immediately on next cron run.
				} else {
					const { sent, logged, error } = await processSmsUpdate(
						supabase,
						user,
						userStocks,
						stocksList,
						smsSender,
					);

					if (sent) {
						stats.smsSent++;
					} else {
						stats.smsFailed++;
					}

					if (!logged) {
						stats.logFailures++;
					}

					await updateScheduledNotificationRow({
						supabase,
						userId: user.id,
						notificationType: "daily_digest",
						scheduledDate,
						scheduledMinutes,
						channel: "sms",
						status: sent ? "sent" : "failed",
						error,
						logger,
					});
				}
			}
		}

		// Query filters out null daily_digest_notification_times with .not()
		const digestTimes = user.daily_digest_notification_times as number[];
		const nextSendAt = calculateNextSendAtFromTimes(
			digestTimes,
			user.timezone,
			currentTime,
		);
		const nextSendAtIso = nextSendAt ? nextSendAt.toISO() : null;
		if (nextSendAt && !nextSendAtIso) {
			logger.error("Failed to format next_send_at ISO string", {
				userId: user.id,
				timezone: user.timezone,
			});
		}
		if (!nextSendAt) {
			logger.warn("calculateNextSendAtFromTimes returned null", {
				userId: user.id,
				daily_digest_notification_times: user.daily_digest_notification_times,
				timezone: user.timezone,
			});
		}

		const { error: updateError } = await supabase
			.from("users")
			.update({ next_send_at: nextSendAtIso })
			.eq("id", user.id);

		if (updateError) {
			logger.error(
				nextSendAtIso
					? "Failed to update users.next_send_at"
					: "Failed to clear users.next_send_at",
				{
					userId: user.id,
					nextSendAt: nextSendAtIso ?? undefined,
				},
				updateError,
			);
		}

		return stats;
	} catch (error) {
		stats.skipped++;
		logger.error("Error processing user", { userId: user.id }, error);

		try {
			const deliveryMethod: DeliveryMethod =
				attemptedDeliveryMethod ??
				(user.email_notifications_enabled ? "email" : "sms");
			await recordNotification(supabase, {
				user_id: user.id,
				type: "scheduled_update",
				delivery_method: deliveryMethod,
				message_delivered: false,
				message: "Error processing notification",
				error: error instanceof Error ? error.message : String(error),
			});
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
