import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { processEmailUpdate } from "../messaging/email/delivery";
import { createEmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { shouldSendSms } from "../messaging/sms";
import { processSmsUpdate } from "../messaging/sms/delivery";
import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "../messaging/sms/twilio-utils";
import type { UserRecord } from "../messaging/types";
import {
	calculateNextSendAtFromTimes,
	getLocalMinutesFromDateTime,
} from "../time/digest-times";
import { toIsoOrThrow } from "../time/format";
import {
	type DeliveryMethod,
	loadUserStocks,
	logRetriesExhausted,
	type ScheduledNotificationTotals,
	type SupabaseAdminClient,
	USER_PROCESS_BATCH_SIZE,
	updateScheduledNotificationRow,
} from "./helpers";

async function runScheduledNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	now?: DateTime;
}): Promise<ScheduledNotificationTotals> {
	const { supabase, logger, forceSend } = options;
	const sendEmail = createEmailSender();

	const currentTime = options.now ?? DateTime.utc();
	const currentTimeIso = toIsoOrThrow(
		currentTime,
		"Failed to format UTC ISO string",
	);

	let query = supabase
		.from("users")
		.select(
			`
			id,
			email,
			phone_country_code,
			phone_number,
			phone_verified,
			timezone,
			daily_digest_enabled,
			daily_digest_notification_times,
			next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled
		`,
		)
		.eq("daily_digest_enabled", true)
		.not("next_send_at", "is", null)
		.not("daily_digest_notification_times", "is", null)
		.or(
			"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
		);
	// When forceSend (manual send), skip due-time filter so notifications go out immediately.
	if (!forceSend) {
		query = query.lte("next_send_at", currentTimeIso);
	}
	const { data, error: usersError } = await query;

	if (usersError) {
		throw new Error(`Failed to fetch users: ${usersError.message}`);
	}
	const users = (data ?? []) as UserRecord[];

	let twilioConfig: ReturnType<typeof readTwilioConfig> | null = null;
	let sendSms: ReturnType<typeof createSmsSender> | null = null;

	interface SmsSenderResult {
		sender: ReturnType<typeof createSmsSender> | null;
		error?: string;
	}

	const getSmsSender = (): SmsSenderResult => {
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

	const processUser = async (user: UserRecord) => {
		const stats: ScheduledNotificationTotals = {
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		};
		let attemptedDeliveryMethod: DeliveryMethod | null = null;

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
			const scheduledMinutes = getLocalMinutesFromDateTime(
				user.timezone,
				dueAt,
			);
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

			const stocksList =
				userStocks.length === 0
					? "You don't have any tracked stocks"
					: userStocks
							.map((stock) => `${stock.symbol} - ${stock.name}`)
							.join(", ");

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

					if (sent) stats.emailsSent++;
					else stats.emailsFailed++;

					if (!logged) stats.logFailures++;

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
						if (!logged) stats.logFailures++;
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

						if (sent) stats.smsSent++;
						else stats.smsFailed++;

						if (!logged) stats.logFailures++;

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
			const nextSendAt = calculateNextSendAtFromTimes(
				user.daily_digest_notification_times ?? [],
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
	};

	const results: Awaited<ReturnType<typeof processUser>>[] = [];
	for (let index = 0; index < users.length; index += USER_PROCESS_BATCH_SIZE) {
		const batch = users.slice(index, index + USER_PROCESS_BATCH_SIZE);
		const batchResults = await Promise.all(batch.map(processUser));
		results.push(...batchResults);
	}

	return results.reduce(
		(acc, curr) => ({
			skipped: acc.skipped + curr.skipped,
			logFailures: acc.logFailures + curr.logFailures,
			emailsSent: acc.emailsSent + curr.emailsSent,
			emailsFailed: acc.emailsFailed + curr.emailsFailed,
			smsSent: acc.smsSent + curr.smsSent,
			smsFailed: acc.smsFailed + curr.smsFailed,
		}),
		{
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		},
	);
}

export { runScheduledNotifications };
