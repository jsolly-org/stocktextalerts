/**
 * Delivery phase for pre-computed notifications.
 *
 * This module is the "send" side of the pre-compute/deliver pipeline. It reads
 * fully rendered content from `staged_notifications`, sends it via the same
 * email/SMS channels used by the normal pipeline, and handles all post-delivery
 * bookkeeping (claim idempotency, notifications_log, next_send_at advancement,
 * Grok counter updates, analyst month tracking).
 *
 * The delivery logic intentionally mirrors the existing daily-digest delivery
 * functions in daily-digest/delivery.ts, but operates on pre-rendered content
 * instead of formatting on the spot.
 */

import { DateTime } from "luxon";
import {
	formatDailyDigestSmsLogMessage,
	summarizeDailyDigestSmsResults,
} from "../daily-digest/delivery";
import { shouldAdvanceDailyDigestSchedule } from "../daily-digest/schedule-state";
import { updateUserDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { sendUserEmail } from "../messaging/email/index";
import type { EmailSender } from "../messaging/email/utils";
import { loadPrefsByUser } from "../messaging/load-prefs";
import {
	buildDelayBannerHtml,
	buildDelayBannerText,
	prependDelayBannerToEmail,
	prependDelayBannerToSms,
	prependDelayBannerToTelegram,
} from "../messaging/parts/delay";
import { deliveryResultToLogFields, recordNotification } from "../messaging/shared";
import { SMS_BODY_CHAR_BUDGET } from "../messaging/sms/block-packing";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { padDailyDigestSmsSegmentBoundaries } from "../messaging/sms/segment-utils";
import type { SmsSenderFactory } from "../messaging/sms/sender-factory";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import { computeDeliveryRetryDelayMs } from "../schedule/retry-delays";
import {
	claimNotification,
	getMaxDailyDigestSlotAttempts,
	updateScheduledNotificationRow,
} from "../scheduled-notifications/store";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { toIsoOrThrow } from "../time/display";
import type {
	DeliveryResult,
	IsoDateString,
	MinuteOfDay,
	StagedDailyData,
	StagedNotificationRow,
	StagedSmsContent,
	UserRecord,
} from "../types";
import {
	deleteStagedNotification,
	fetchDueStagedNotifications,
	purgeStaleStaged,
	rescheduleStagedNotification,
} from "./db";

const STALE_MAX_AGE_MINUTES = 5;
const TWILIO_SMS_HARD_LIMIT = 1600;

function normalizeStagedSmsMessages(sms: StagedSmsContent): string[] {
	if ("messages" in sms) {
		return sms.messages;
	}

	return [sms.message];
}

function padStagedDailyDigestSmsMessages(messages: string[]): string[] {
	return messages.map((message) => padDailyDigestSmsSegmentBoundaries(message));
}

function buildFinalStagedSmsMessages(
	sms: StagedSmsContent,
	delayText: string | null,
	logger: Logger,
	context: { userId: string; scheduledDate: IsoDateString; scheduledMinutes: MinuteOfDay },
): string[] {
	const messages = normalizeStagedSmsMessages(sms);
	if (!delayText || messages.length === 0) {
		return padStagedDailyDigestSmsMessages(messages);
	}

	const delayedFirst = padDailyDigestSmsSegmentBoundaries(
		prependDelayBannerToSms(messages[0] ?? "", delayText),
	);
	if (delayedFirst.length <= TWILIO_SMS_HARD_LIMIT) {
		return [delayedFirst, ...padStagedDailyDigestSmsMessages(messages.slice(1))];
	}

	logger.warn(
		"Delayed staged Daily Digest SMS first part exceeds Twilio limit; sending delay notice separately",
		{
			...context,
			partLength: delayedFirst.length,
			budget: SMS_BODY_CHAR_BUDGET,
			hardLimit: TWILIO_SMS_HARD_LIMIT,
		},
	);

	return [
		padDailyDigestSmsSegmentBoundaries(delayText),
		...padStagedDailyDigestSmsMessages(messages),
	];
}

/** Deliver all staged notifications that are due (scheduled_for <= now). */
export async function deliverStagedNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderFactory;
	getTelegramSender: TelegramSenderFactory;
}): Promise<{
	stats: ScheduledNotificationTotals;
	deliveredUserTypes: Set<string>;
}> {
	const { supabase, logger, currentTime, sendEmail, getSmsSender, getTelegramSender } = options;

	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
	};

	// Track which user+type combos were handled via staging so fallback can skip them.
	//
	// IMPORTANT: this must be updated immediately after a successful send (per channel)
	// so that unexpected bookkeeping errors after a partial delivery cannot cause the
	// fallback pipeline to re-send.
	const deliveredUserTypes = new Set<string>();

	// Purge stale rows first
	try {
		const purged = await purgeStaleStaged(supabase, STALE_MAX_AGE_MINUTES);
		if (purged > 0) {
			logger.info("Purged stale staged notifications", {
				action: "staged_deliver",
				purgedCount: purged,
			});
		}
	} catch (error) {
		logger.error("Failed to purge stale staged notifications", { action: "staged_deliver" }, error);
	}

	const currentTimeIso = toIsoOrThrow(currentTime, "Failed to format currentTime ISO");

	// Fetch due staged rows
	let dailyRows: StagedNotificationRow[] = [];
	try {
		dailyRows = await fetchDueStagedNotifications(supabase, {
			cutoffTimeIso: currentTimeIso,
			notificationType: "daily",
		});
	} catch (error) {
		logger.error("Failed to fetch due staged notifications", { action: "staged_deliver" }, error);
		return { stats, deliveredUserTypes };
	}

	if (dailyRows.length === 0) {
		return { stats, deliveredUserTypes };
	}

	// Batch-fetch user records (channel-level columns; per-option facets live in
	// notification_preferences and are attached below).
	const userIds = [...new Set(dailyRows.map((r) => r.user_id))];
	const { data: users, error: usersError } = await supabase
		.from("users")
		.select(
			`
			id,
			email,
			phone_country_code,
			phone_number,
			phone_verified,
			timezone,
			use_24_hour_time,
			market_scheduled_asset_price_enabled,
			market_scheduled_asset_price_times,
			daily_notification_time,
			daily_notification_next_send_at,
			market_scheduled_asset_price_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
			asset_events_last_analyst_sent_month,
			telegram_chat_id,
			telegram_opted_out,
			last_grok_rumors_at,
			grok_window_start,
			grok_sends_in_window
		`,
		)
		.in("id", userIds);

	if (usersError) {
		logger.error(
			"Failed to fetch users for staged delivery",
			{ action: "staged_deliver", userCount: userIds.length },
			usersError,
		);
		return { stats, deliveredUserTypes };
	}

	const prefsByUser = await loadPrefsByUser(supabase, userIds);
	const userMap = new Map(
		// Cast is intentionally narrow: the select above includes the channel-level
		// fields required by the downstream delivery helpers; prefs carry per-option facets.
		(users ?? []).map((u) => [
			u.id,
			{ ...u, prefs: prefsByUser.get(u.id) ?? [] } as unknown as UserRecord,
		]),
	);

	for (const row of dailyRows) {
		const user = userMap.get(row.user_id);
		if (!user) {
			logger.error(
				"User not found for staged delivery, deleting row",
				{ action: "staged_deliver", stagedId: row.id, userId: row.user_id },
				new Error("User not found for staged delivery"),
			);
			try {
				await deleteStagedNotification(supabase, row.id);
			} catch (error) {
				logger.error(
					"Failed to delete staged notification (user not found)",
					{ action: "staged_deliver", stagedId: row.id, userId: row.user_id },
					error,
				);
			}
			continue;
		}

		try {
			await deliverStagedDaily({
				row,
				stagedData: row.staged_data as StagedDailyData,
				user,
				supabase,
				logger,
				currentTime,
				sendEmail,
				getSmsSender,
				getTelegramSender,
				deliveredUserTypes,
				stats,
			});
		} catch (error) {
			const stagedRaw = row.staged_data;
			const stagedKeys =
				typeof stagedRaw === "object" && stagedRaw !== null ? Object.keys(stagedRaw as object) : [];
			const staged = stagedRaw as StagedDailyData | null;
			const smsPartCount = staged?.sms ? normalizeStagedSmsMessages(staged.sms).length : 0;
			logger.error(
				"Error delivering staged notification",
				{
					action: "staged_deliver",
					stagedId: row.id,
					userId: row.user_id,
					type: row.notification_type,
					scheduledFor: row.scheduled_for,
					stagedDataKeys: stagedKeys,
					hasEmail: Boolean(staged?.email),
					hasSms: Boolean(staged?.sms),
					hasTelegram: Boolean(staged?.telegram),
					smsPartCount,
					emailHtmlLength: staged?.email?.html?.length ?? 0,
					emailSubjectLength: staged?.email?.subject?.length ?? 0,
				},
				error,
			);
			stats.skipped++;

			if (staged?.scheduledDate && staged.scheduledMinutes !== undefined) {
				try {
					const priorAttempts = await getMaxDailyDigestSlotAttempts({
						supabase,
						userId: row.user_id,
						scheduledDate: staged.scheduledDate,
						scheduledMinutes: staged.scheduledMinutes,
					});
					const retryAt = currentTime.plus({
						milliseconds: computeDeliveryRetryDelayMs(priorAttempts),
					});
					const retryAtIso = toIsoOrThrow(retryAt, "Failed to format staged outer retry time");
					await rescheduleStagedNotification(supabase, {
						id: row.id,
						scheduledForIso: retryAtIso,
					});
					logger.info("Rescheduled staged daily digest after outer delivery error", {
						action: "staged_deliver",
						userId: row.user_id,
						stagedId: row.id,
						retryAtIso,
					});
				} catch (rescheduleError) {
					logger.error(
						"Failed to reschedule staged notification after outer delivery error",
						{ userId: row.user_id, stagedId: row.id },
						rescheduleError,
					);
				}
			}
		}
	}

	return { stats, deliveredUserTypes };
}

/** Deliver a single staged daily-digest row. */
async function deliverStagedDaily(options: {
	row: StagedNotificationRow;
	stagedData: StagedDailyData;
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderFactory;
	getTelegramSender: TelegramSenderFactory;
	deliveredUserTypes: Set<string>;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		row,
		stagedData,
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		getTelegramSender,
		deliveredUserTypes,
		stats,
	} = options;
	const { scheduledDate, scheduledMinutes } = stagedData;
	const deliveredKey = `${row.user_id}:daily`;
	let localEmailDelivered = false;
	let localSmsDelivered = false;
	let localTelegramDelivered = false;

	// Detect delay for staged content delivered after scheduled time
	const dailyScheduledFor = DateTime.fromISO(row.scheduled_for, {
		zone: "utc",
	});
	const dailyDelayOpts = dailyScheduledFor.isValid
		? {
				scheduledFor: dailyScheduledFor,
				now: currentTime,
				userTimezone: user.timezone,
				use24Hour: user.use_24_hour_time,
			}
		: null;
	const dailyDelayText = dailyDelayOpts ? buildDelayBannerText(dailyDelayOpts) : null;
	const dailyDelayHtml = dailyDelayOpts ? buildDelayBannerHtml(dailyDelayOpts) : null;

	// Email delivery
	if (stagedData.email) {
		const emailContent =
			dailyDelayText && dailyDelayHtml
				? prependDelayBannerToEmail(
						stagedData.email.text,
						stagedData.email.html,
						dailyDelayText,
						dailyDelayHtml,
					)
				: { text: stagedData.email.text, html: stagedData.email.html };

		const claim = await claimNotification({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "email",
			logger,
		});

		if (claim.status === "claimed") {
			// Dedup here is the claimNotification CAS above, not an email-level key — the
			// direct-SES path does not honor idempotency keys.
			const result = await sendUserEmail(
				user,
				stagedData.email.subject,
				{ text: emailContent.text, html: emailContent.html },
				sendEmail,
			);

			// Mark as delivered immediately after a successful send so fallback doesn't
			// reprocess if later bookkeeping fails.
			if (result.success) {
				localEmailDelivered = true;
				deliveredUserTypes.add(deliveredKey);
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "daily",
				delivery_method: "email",
				message_delivered: result.success,
				message: emailContent.text,
				...deliveryResultToLogFields(result),
			});
			if (!logged) stats.logFailures++;

			if (result.success) {
				stats.emailsSent++;
			} else {
				stats.emailsFailed++;
			}

			await updateScheduledNotificationRow({
				supabase,
				userId: user.id,
				notificationType: "daily",
				scheduledDate,
				scheduledMinutes,
				channel: "email",
				status: result.success ? "sent" : "failed",
				error: result.success ? undefined : result.error,
				attemptCount: claim.attemptCount,
				logger,
			});
		} else if (claim.status === "claim_error") {
			stats.emailsFailed++;
		} else if (claim.status === "retries_exhausted") {
			stats.skipped++;
		} else {
			stats.skipped++;
		}
	}

	// SMS delivery
	if (stagedData.sms) {
		const dailySmsMessages = buildFinalStagedSmsMessages(stagedData.sms, dailyDelayText, logger, {
			userId: user.id,
			scheduledDate,
			scheduledMinutes,
		});

		const smsEnabled = shouldSendSms(user);
		if (smsEnabled) {
			const claim = await claimNotification({
				supabase,
				userId: user.id,
				notificationType: "daily",
				scheduledDate,
				scheduledMinutes,
				channel: "sms",
				logger,
			});

			if (claim.status === "claimed") {
				try {
					const { sender } = getSmsSender();
					const partResults: DeliveryResult[] = [];
					for (const [index, smsMessage] of dailySmsMessages.entries()) {
						if (smsMessage.length > SMS_BODY_CHAR_BUDGET) {
							logger.warn("Staged Daily Digest SMS part exceeds preferred body budget", {
								userId: user.id,
								scheduledDate,
								scheduledMinutes,
								partNumber: index + 1,
								totalParts: dailySmsMessages.length,
								partLength: smsMessage.length,
								budget: SMS_BODY_CHAR_BUDGET,
								hardLimit: TWILIO_SMS_HARD_LIMIT,
							});
						}

						if (smsMessage.length > TWILIO_SMS_HARD_LIMIT) {
							const partResult: DeliveryResult = {
								success: false,
								error: `SMS body exceeds Twilio hard limit (${smsMessage.length}/${TWILIO_SMS_HARD_LIMIT})`,
								errorCode: "SMS_BODY_TOO_LONG",
							};
							partResults.push(partResult);
							logger.error(
								"Staged Daily Digest SMS part exceeds Twilio hard limit",
								{
									userId: user.id,
									scheduledDate,
									scheduledMinutes,
									partNumber: index + 1,
									totalParts: dailySmsMessages.length,
									partLength: smsMessage.length,
									hardLimit: TWILIO_SMS_HARD_LIMIT,
								},
								new Error(partResult.error),
							);
							break;
						}

						const partResult = await sendUserSms(user, smsMessage, sender, supabase);
						partResults.push(partResult);

						if (!partResult.success) {
							logger.error(
								"Failed to send staged Daily Digest SMS part",
								{
									userId: user.id,
									scheduledDate,
									scheduledMinutes,
									partNumber: index + 1,
									totalParts: dailySmsMessages.length,
									partLength: smsMessage.length,
									errorCode: partResult.errorCode ?? null,
								},
								new Error(partResult.error ?? "Staged Daily Digest SMS part failed"),
							);
							break;
						}
					}

					const result = summarizeDailyDigestSmsResults(partResults, dailySmsMessages.length);

					// Mark as delivered immediately after a successful send so fallback doesn't
					// reprocess if later bookkeeping fails.
					if (result.success) {
						localSmsDelivered = true;
						deliveredUserTypes.add(deliveredKey);
					}

					const logged = await recordNotification(supabase, {
						user_id: user.id,
						type: "daily",
						delivery_method: "sms",
						message_delivered: result.success,
						message: formatDailyDigestSmsLogMessage(dailySmsMessages),
						...deliveryResultToLogFields(result),
					});
					if (!logged) stats.logFailures++;

					if (result.success) {
						stats.smsSent++;
					} else {
						stats.smsFailed++;
					}

					await updateScheduledNotificationRow({
						supabase,
						userId: user.id,
						notificationType: "daily",
						scheduledDate,
						scheduledMinutes,
						channel: "sms",
						status: result.success ? "sent" : "failed",
						error: result.success ? undefined : result.error,
						attemptCount: claim.attemptCount,
						logger,
					});
				} catch (error) {
					stats.smsFailed++;
					logger.error(
						"Failed to resolve SMS sender for staged daily delivery",
						{ userId: user.id },
						error,
					);
					await updateScheduledNotificationRow({
						supabase,
						userId: user.id,
						notificationType: "daily",
						scheduledDate,
						scheduledMinutes,
						channel: "sms",
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
						attemptCount: claim.attemptCount,
						logger,
					});
				}
			} else if (claim.status === "claim_error") {
				stats.smsFailed++;
			} else if (claim.status === "retries_exhausted") {
				stats.skipped++;
			} else {
				// Claim held by another worker or backoff pending — do not suppress fallback.
				stats.skipped++;
			}
		}
	}

	// Telegram delivery
	if (stagedData.telegram && isTelegramChannelUsable(user) && user.telegram_chat_id != null) {
		const claim = await claimNotification({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "telegram",
			logger,
		});

		if (claim.status === "claimed") {
			try {
				const { sender } = getTelegramSender();
				const telegramPayload =
					dailyDelayText && stagedData.telegram
						? prependDelayBannerToTelegram(
								stagedData.telegram.text,
								stagedData.telegram.entities,
								dailyDelayText,
							)
						: stagedData.telegram;
				const result = await sender({
					chatId: user.telegram_chat_id,
					text: telegramPayload.text,
					entities: telegramPayload.entities,
					// Routine scheduled digest — deliver silently like the live path.
					disableNotification: true,
				});

				if (!result.success) {
					logger.error(
						"Failed to send staged Daily Digest Telegram message",
						{
							userId: user.id,
							scheduledDate,
							scheduledMinutes,
							errorCode: result.errorCode ?? null,
						},
						new Error(result.error ?? "Staged Daily Digest Telegram send failed"),
					);
				}

				await optOutIfBotBlocked(supabase, user.id, result, logger);

				// Mark as delivered immediately after a successful send so fallback doesn't
				// reprocess if later bookkeeping fails.
				if (result.success) {
					localTelegramDelivered = true;
					deliveredUserTypes.add(deliveredKey);
				}

				const logged = await recordNotification(supabase, {
					user_id: user.id,
					type: "daily",
					delivery_method: "telegram",
					message_delivered: result.success,
					message: stagedData.telegram.text,
					...deliveryResultToLogFields(result),
				});
				if (!logged) stats.logFailures++;

				if (result.success) {
					stats.telegramSent++;
				} else {
					stats.telegramFailed++;
				}

				await updateScheduledNotificationRow({
					supabase,
					userId: user.id,
					notificationType: "daily",
					scheduledDate,
					scheduledMinutes,
					channel: "telegram",
					status: result.success ? "sent" : "failed",
					error: result.success ? undefined : result.error,
					attemptCount: claim.attemptCount,
					logger,
				});
			} catch (error) {
				stats.telegramFailed++;
				logger.error(
					"Failed to resolve Telegram sender for staged daily delivery",
					{ userId: user.id, scheduledDate, scheduledMinutes },
					error,
				);
				await updateScheduledNotificationRow({
					supabase,
					userId: user.id,
					notificationType: "daily",
					scheduledDate,
					scheduledMinutes,
					channel: "telegram",
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					attemptCount: claim.attemptCount,
					logger,
				});
			}
		} else if (claim.status === "claim_error") {
			stats.telegramFailed++;
		} else if (claim.status === "retries_exhausted") {
			stats.skipped++;
		} else {
			stats.skipped++;
		}
	}

	// Post-delivery: Grok counter update.
	// This replicates the updateGrokSendCounter logic from daily-digest/process.ts
	// inline rather than importing it, because that function is tightly coupled to
	// the ScheduledNotificationTotals stats object and would create a circular
	// dependency. The logic is straightforward: reset the rolling window if expired,
	// otherwise increment the counter.
	const localDelivered = localEmailDelivered || localSmsDelivered || localTelegramDelivered;
	if (stagedData.grokAllowed && localDelivered) {
		const GROK_WINDOW_HOURS = 24;
		const now = currentTime.toISO();
		if (now) {
			const windowStart = user.grok_window_start
				? DateTime.fromISO(user.grok_window_start, { zone: "utc" })
				: null;
			const windowExpired =
				!windowStart?.isValid || currentTime.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS;

			const newCount = windowExpired ? 1 : user.grok_sends_in_window + 1;
			const newWindowStart = windowExpired ? now : user.grok_window_start;

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
					"Failed to update grok send counter (staged daily)",
					{ userId: user.id, newCount, newWindowStart },
					error,
				);
			}
		}
	}

	const emailRequired = stagedData.email !== null;
	const smsRequired = stagedData.sms !== null;
	// Loose `!= null`: rows staged before the `telegram` field existed deserialize with
	// `telegram: undefined`. Strict `!== null` would make those legacy rows "require"
	// Telegram while the delivery block (falsy guard above) skips it — wedging canAdvance.
	const telegramRequired = stagedData.telegram != null;
	const canAdvance = await shouldAdvanceDailyDigestSchedule({
		supabase,
		user,
		scheduledDate,
		scheduledMinutes,
		emailRequired,
		smsRequired,
		telegramRequired,
	});

	if (canAdvance) {
		try {
			await deleteStagedNotification(supabase, row.id);
		} catch (error) {
			logger.error(
				"Failed to delete staged notification row after delivery",
				{ action: "staged_deliver", stagedId: row.id, userId: row.user_id },
				error,
			);
		}

		try {
			await updateUserDailyNotificationNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} catch (error) {
			logger.error(
				"Failed to advance next_send_at for staged daily delivery",
				{ userId: user.id },
				error,
			);
		}
	} else {
		const priorAttempts = await getMaxDailyDigestSlotAttempts({
			supabase,
			userId: user.id,
			scheduledDate,
			scheduledMinutes,
		});
		const retryAt = currentTime.plus({
			milliseconds: computeDeliveryRetryDelayMs(priorAttempts),
		});
		const retryAtIso = toIsoOrThrow(retryAt, "Failed to format staged retry time");
		try {
			await rescheduleStagedNotification(supabase, {
				id: row.id,
				scheduledForIso: retryAtIso,
			});
			logger.info("Rescheduled staged daily digest for delivery retry", {
				action: "staged_deliver",
				userId: user.id,
				stagedId: row.id,
				retryAtIso,
			});
		} catch (error) {
			logger.error(
				"Failed to reschedule staged notification for retry",
				{ userId: user.id, stagedId: row.id },
				error,
			);
		}
	}

	// Update analyst sent month if applicable
	if (canAdvance && stagedData.shouldUpdateAnalyst && stagedData.analystMonth) {
		const { error: analystError } = await supabase
			.from("users")
			.update({
				asset_events_last_analyst_sent_month: stagedData.analystMonth,
			})
			.eq("id", user.id);
		if (analystError) {
			logger.error(
				"Failed to update asset_events_last_analyst_sent_month (staged)",
				{ userId: user.id },
				analystError,
			);
		}
	}
}
