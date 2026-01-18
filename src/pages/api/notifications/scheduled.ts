import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import type { Database } from "../../../lib/generated/database.types";
import { createSupabaseAdminClient } from "../../../lib/supabase";
import { createEmailSender } from "./email/utils";
import { processEmailUpdate, processSmsUpdate } from "./processing";
import {
	calculateNextSendAt,
	type DeliveryMethod,
	loadUserStocks,
	recordNotification,
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

function getLocalDateString(timezone: string, date: Date): string | null {
	try {
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		return formatter.format(date);
	} catch {
		console.error("Failed to format local date for timezone", { timezone });
		return null;
	}
}

async function updateScheduledNotificationRow(options: {
	supabase: ReturnType<typeof createSupabaseAdminClient>;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	channel: DeliveryMethod;
	status: Extract<
		Database["public"]["Enums"]["scheduled_notification_status"],
		"sent" | "failed"
	>;
	error?: string;
}) {
	const update: Database["public"]["Tables"]["scheduled_notifications"]["Update"] =
		options.status === "sent"
			? { status: "sent", sent_at: new Date().toISOString(), error: null }
			: { status: "failed", error: options.error ?? "Unknown error" };

	const { error } = await options.supabase
		.from("scheduled_notifications")
		.update(update)
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("channel", options.channel);

	if (error) {
		console.error("Failed to update scheduled_notifications row", {
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
		console.error("Failed to fetch scheduled_notifications row", {
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
		console.warn(
			`Retries exhausted for user ${options.userId} (${options.channel}); will retry next local day`,
		);

		await recordNotification(options.supabase, {
			userId: options.userId,
			type: "scheduled_update",
			deliveryMethod: options.channel,
			messageDelivered: false,
			message: "Retries exhausted; will retry next local day",
			error: `scheduled_notifications attempt_count >= ${MAX_NOTIFICATION_RETRIES}`,
		});
	}
}

export const POST: APIRoute = async ({ request }) => {
	const authHeader = request.headers.get("authorization");
	const envCronSecret = import.meta.env.CRON_SECRET;

	if (!envCronSecret) {
		console.error("CRON_SECRET environment variable is not configured");
		return new Response("Server misconfigured", { status: 500 });
	}

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
			console.error("Failed to compare cron secrets securely", error);
			return new Response("Internal server error", { status: 500 });
		}
	}

	if (!authorized) {
		return new Response("Unauthorized", { status: 401 });
	}

	const supabase = createSupabaseAdminClient();

	try {
		const sendEmail = createEmailSender();

		const currentTime = new Date();

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
			.lte("next_send_at", currentTime.toISOString())
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
				console.error("Failed to initialize Twilio client:", errorMsg);
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
				if (!user.timezone) {
					stats.skipped++;
					return stats;
				}

				const dueAt = user.next_send_at ? new Date(user.next_send_at) : null;
				if (!dueAt || Number.isNaN(dueAt.getTime())) {
					console.warn("Invalid next_send_at for user; skipping notification", {
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
						console.error("Failed to claim scheduled notification (email)", {
							userId: user.id,
							error: claimError.message,
						});
						stats.emailsFailed++;
					} else if (!claimed) {
						await logRetriesExhausted({
							supabase,
							userId: user.id,
							notificationType: "daily_digest",
							scheduledDate,
							channel: "email",
						});
						stats.skipped++;
					} else {
						const { sent, logged, error } = await processEmailUpdate(
							supabase,
							user,
							userStocks,
							stocksList,
							sendEmail,
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
						console.error("Failed to claim scheduled notification (sms)", {
							userId: user.id,
							error: claimError.message,
						});
						stats.smsFailed++;
					} else if (!claimed) {
						await logRetriesExhausted({
							supabase,
							userId: user.id,
							notificationType: "daily_digest",
							scheduledDate,
							channel: "sms",
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
							});
							const logged = await recordNotification(supabase, {
								userId: user.id,
								type: "scheduled_update",
								deliveryMethod: "sms",
								messageDelivered: false,
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
							});
						}
					}
				}

				const nextSendAt = calculateNextSendAt(
					user.daily_digest_notification_time,
					user.timezone,
					() => currentTime,
				);
				if (nextSendAt) {
					const { error: updateError } = await supabase
						.from("users")
						.update({ next_send_at: nextSendAt.toISOString() })
						.eq("id", user.id);

					if (updateError) {
						console.error("Failed to update users.next_send_at", {
							userId: user.id,
							nextSendAt: nextSendAt.toISOString(),
							error: updateError,
						});
					}
				} else {
					console.warn("calculateNextSendAt returned null", {
						userId: user.id,
						daily_digest_notification_time: user.daily_digest_notification_time,
						timezone: user.timezone,
					});

					const { error: updateError } = await supabase
						.from("users")
						.update({ next_send_at: null })
						.eq("id", user.id);

					if (updateError) {
						console.error("Failed to clear users.next_send_at", {
							userId: user.id,
							error: updateError,
						});
					}
				}

				return stats;
			} catch (error) {
				stats.skipped++;
				console.error(`Error processing user ${user.id}:`, error);

				try {
					const deliveryMethod: DeliveryMethod =
						attemptedDeliveryMethod ??
						(user.email_notifications_enabled ? "email" : "sms");
					await recordNotification(supabase, {
						userId: user.id,
						type: "scheduled_update",
						deliveryMethod,
						messageDelivered: false,
						message: "Error processing notification",
						error: error instanceof Error ? error.message : String(error),
					});
				} catch (logError) {
					console.error(
						`Failed to record notification for user ${user.id}:`,
						logError,
					);
					stats.logFailures++;
				}

				return stats;
			}
		};

		const results = await Promise.all((users ?? []).map(processUser));

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
		console.error("Cron job error:", error);
		return new Response("Internal server error", { status: 500 });
	}
};
