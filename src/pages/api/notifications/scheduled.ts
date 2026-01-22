import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import type { Database } from "../../../lib/db/generated/database.types";
import { createSupabaseAdminClient } from "../../../lib/db/supabase";
import { createLogger, type Logger } from "../../../lib/logging";
import { getUtcIso } from "../../../lib/time/format";
import {
	calculateNextSendAt,
	getLocalDateString,
} from "../../../lib/time/schedule";
import { createEmailSender } from "./email/utils";
import { processEmailUpdate, processSmsUpdate } from "./processing";
import {
	type DeliveryMethod,
	loadUserStocks,
	recordNotification,
	type ScheduledNotificationStatus,
	type ScheduledNotificationType,
	type UserRecord,
} from "./shared";
import { shouldSendSms } from "./sms";
import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "./sms/twilio-utils";

const MAX_NOTIFICATION_RETRIES = 3;
const USER_PROCESS_BATCH_SIZE = 5;

async function updateScheduledNotificationRow(options: {
	supabase: ReturnType<typeof createSupabaseAdminClient>;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	channel: DeliveryMethod;
	status: Extract<ScheduledNotificationStatus, "sent" | "failed">;
	error?: string;
	logger: Logger;
}) {
	const update: Database["public"]["Tables"]["scheduled_notifications"]["Update"] =
		options.status === "sent"
			? { status: "sent", sent_at: getUtcIso(), error: null }
			: { status: "failed", error: options.error ?? "Unknown error" };

	const { error } = await options.supabase
		.from("scheduled_notifications")
		.update(update)
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("channel", options.channel);

	if (error) {
		options.logger.error("Failed to update scheduled_notifications row", {
			userId: options.userId,
			channel: options.channel,
			error,
		});
	}
}

async function logRetriesExhausted(options: {
	supabase: ReturnType<typeof createSupabaseAdminClient>;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	channel: DeliveryMethod;
	logger: Logger;
}) {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("attempt_count,status")
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("channel", options.channel)
		.maybeSingle();

	if (error) {
		options.logger.error("Failed to fetch scheduled_notifications row", {
			userId: options.userId,
			channel: options.channel,
			error,
		});
		return;
	}

	if (!data || data.status === "sent") {
		return;
	}

	if (data.attempt_count >= MAX_NOTIFICATION_RETRIES) {
		options.logger.warn("Retries exhausted; will retry next local day", {
			userId: options.userId,
			channel: options.channel,
		});

		await recordNotification(options.supabase, {
			user_id: options.userId,
			type: "scheduled_update",
			delivery_method: options.channel,
			message_delivered: false,
			message: "Retries exhausted; will retry next local day",
			error: `scheduled_notifications attempt_count >= ${MAX_NOTIFICATION_RETRIES}`,
		});
	}
}

export const POST: APIRoute = async ({ request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const authHeader = request.headers.get("authorization");
	const envCronSecret = import.meta.env.CRON_SECRET;

	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return new Response("Unauthorized", { status: 401 });
	}

	const cronSecret = authHeader.split("Bearer ")[1];
	let authorized = false;

	if (cronSecret.length === envCronSecret.length) {
		try {
			authorized = timingSafeEqual(
				Buffer.from(cronSecret),
				Buffer.from(envCronSecret),
			);
		} catch (error) {
			logger.error("Failed to compare cron secrets securely", undefined, error);
			return new Response("Internal server error", { status: 500 });
		}
	}

	if (!authorized) {
		return new Response("Unauthorized", { status: 401 });
	}

	const supabase = createSupabaseAdminClient();

	try {
		const sendEmail = createEmailSender();

		const currentTime = DateTime.utc();
		const currentTimeIso = getUtcIso(currentTime);

		const { data: users, error: usersError } = await supabase
			.from("users")
			.select(
				`
			id,
			email,
			phone_country_code,
			phone_number,
			phone_verified,
			sms_opted_out,
			timezone,
			daily_digest_enabled,
			daily_digest_notification_time,
			next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled
		`,
			)
			.eq("daily_digest_enabled", true)
			.not("next_send_at", "is", null)
			.lte("next_send_at", currentTimeIso)
			.or(
				"email_notifications_enabled.eq.true,sms_notifications_enabled.eq.true",
			);

		if (usersError) {
			const errorMsg =
				usersError instanceof Error
					? usersError.message
					: JSON.stringify(usersError);
			throw new Error(`Failed to fetch users: ${errorMsg}`);
		}

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
				logger.error("Failed to initialize Twilio client", { error: errorMsg });
				return { sender: null, error: errorMsg };
			}
		};

		const processUser = async (user: UserRecord) => {
			const stats = {
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
				const scheduledDate = getLocalDateString(user.timezone, dueAt);
				if (!scheduledDate) {
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
							channel: "email",
							logger,
						});
						stats.skipped++;
					} else {
						const emailIdempotencyKey = `daily-digest/${user.id}/${scheduledDate}/email`;
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
								channel: "sms",
								status: sent ? "sent" : "failed",
								error,
								logger,
							});
						}
					}
				}

				const nextSendAt = calculateNextSendAt(
					user.daily_digest_notification_time,
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
					logger.warn("calculateNextSendAt returned null", {
						userId: user.id,
						daily_digest_notification_time: user.daily_digest_notification_time,
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
		for (
			let index = 0;
			index < users.length;
			index += USER_PROCESS_BATCH_SIZE
		) {
			const batch = users.slice(index, index + USER_PROCESS_BATCH_SIZE);
			const batchResults = await Promise.all(batch.map(processUser));
			results.push(...batchResults);
		}

		const totals = results.reduce(
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

		return new Response(JSON.stringify({ success: true, ...totals }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		logger.error("Cron job error", undefined, error);
		return new Response("Internal server error", { status: 500 });
	}
};
