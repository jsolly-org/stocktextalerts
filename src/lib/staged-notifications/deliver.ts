/**
 * Delivery phase for pre-computed notifications.
 *
 * This module is the "send" side of the pre-compute/deliver pipeline. It reads
 * fully rendered content from `staged_notifications`, sends it via the same
 * email/Telegram channels used by the normal pipeline, and handles all post-delivery
 * bookkeeping (claim idempotency, notifications_log, next_send_at advancement,
 * Grok counter updates, analyst month tracking).
 *
 * The delivery logic intentionally mirrors the existing daily-digest delivery
 * functions in daily-digest/delivery.ts, but operates on pre-rendered content
 * instead of formatting on the spot.
 */

import { DateTime } from "luxon";
import { updateGrokSendCounter } from "../daily-digest/content-build";
import { shouldAdvanceDailyDigestSchedule } from "../daily-digest/schedule-state";
import { updateUserDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { sendUserEmail } from "../messaging/email/index";
import { loadPrefsByUser } from "../messaging/load-prefs";
import {
	buildDelayBannerHtml,
	buildDelayBannerText,
	prependDelayBannerToEmail,
	prependDelayBannerToTelegram,
} from "../messaging/parts/delay";
import {
	claimScheduledChannel,
	completeScheduledChannelFromResult,
	releaseScheduledChannelBudget,
	reserveScheduledChannelBudget,
} from "../messaging/scheduled-channel";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import type { TelegramSenderFactory } from "../messaging/telegram/sender-factory";
import type { EmailSender } from "../messaging/types";
import { computeDeliveryRetryDelayMs } from "../schedule/retry-delays";
import {
	getMaxDailyDigestSlotAttempts,
	updateScheduledNotificationRow,
} from "../scheduled-notifications/store";
import type { ScheduledNotificationTotals } from "../scheduled-notifications/types";
import { toIsoOrThrow } from "../time/display";
import {
	isRecord,
	type StagedDailyData,
	type StagedNotificationRow,
	type UserRecord,
} from "../types";
import {
	deleteStagedNotification,
	fetchDueStagedNotifications,
	purgeStaleStaged,
	rescheduleStagedNotification,
} from "./db";

const STALE_MAX_AGE_MINUTES = 5;

/** Deliver all staged notifications that are due (scheduled_for <= now). */
export async function deliverStagedNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getTelegramSender: TelegramSenderFactory;
}): Promise<{
	stats: ScheduledNotificationTotals;
	deliveredUserTypes: Set<string>;
}> {
	const { supabase, logger, currentTime, sendEmail, getTelegramSender } = options;

	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
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
			timezone,
			use_24_hour_time,
			market_scheduled_asset_price_enabled,
			market_scheduled_asset_price_times,
			daily_notification_time,
			daily_notification_next_send_at,
			market_scheduled_asset_price_next_send_at,
			email_notifications_enabled,
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
				getTelegramSender,
				deliveredUserTypes,
				stats,
			});
		} catch (error) {
			const stagedRaw = row.staged_data;
			const stagedKeys = isRecord(stagedRaw) ? Object.keys(stagedRaw) : [];
			const staged = stagedRaw as StagedDailyData | null;
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
					hasTelegram: Boolean(staged?.telegram),
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
		getTelegramSender,
		deliveredUserTypes,
		stats,
	} = options;
	const { scheduledDate, scheduledMinutes } = stagedData;
	const deliveredKey = `${row.user_id}:daily`;
	let localEmailDelivered = false;
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

		const attemptCount = await claimScheduledChannel({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "email",
			logger,
			stats,
		});

		if (attemptCount !== null) {
			const budgetReserved = await reserveScheduledChannelBudget({
				supabase,
				userId: user.id,
				notificationType: "daily",
				scheduledDate,
				scheduledMinutes,
				channel: "email",
				logger,
				stats,
				attemptCount,
			});
			if (!budgetReserved) {
				// Slot terminal-skipped; fall through to Telegram / bookkeeping.
			} else {
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

				await completeScheduledChannelFromResult({
					supabase,
					userId: user.id,
					notificationType: "daily",
					scheduledDate,
					scheduledMinutes,
					channel: "email",
					logger,
					stats,
					attemptCount,
					result,
					logMessage: emailContent.text,
					budgetReserved: true,
				});
			}
		}
	}

	// Telegram delivery
	if (stagedData.telegram && isTelegramChannelUsable(user) && user.telegram_chat_id != null) {
		const attemptCount = await claimScheduledChannel({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "telegram",
			logger,
			stats,
		});

		if (attemptCount !== null) {
			const budgetReserved = await reserveScheduledChannelBudget({
				supabase,
				userId: user.id,
				notificationType: "daily",
				scheduledDate,
				scheduledMinutes,
				channel: "telegram",
				logger,
				stats,
				attemptCount,
			});
			if (!budgetReserved) {
				// Slot terminal-skipped or deferred for budget-check retry.
			} else {
				let sendSucceeded = false;
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
						// replyMarkup rides from the staged row (prependDelayBannerToTelegram only
						// rewrites text/entities). Legacy rows staged before this field shipped
						// deserialize with `replyMarkup: undefined` → sent buttonless.
						...(stagedData.telegram.replyMarkup
							? { replyMarkup: stagedData.telegram.replyMarkup }
							: {}),
						// Routine scheduled digest — deliver silently like the live path.
						disableNotification: true,
					});
					sendSucceeded = result.success;

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

					await completeScheduledChannelFromResult({
						supabase,
						userId: user.id,
						notificationType: "daily",
						scheduledDate,
						scheduledMinutes,
						channel: "telegram",
						logger,
						stats,
						attemptCount,
						result,
						// The logged message deliberately omits the delay banner (telegramPayload
						// prepends it for the send only).
						logMessage: stagedData.telegram.text,
						budgetReserved: true,
					});
				} catch (error) {
					// Only refund when the message was not delivered. A post-send bookkeeping
					// throw must not restore budget (that would bypass the daily cap).
					if (!sendSucceeded) {
						await releaseScheduledChannelBudget(supabase, user.id, "daily");
					}
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
						attemptCount,
						logger,
					});
				}
			}
		}
	}

	// Post-delivery: Grok counter update (gated on this user's sends, not the
	// run-cumulative stats — see updateGrokSendCounter's delivered param).
	const localDelivered = localEmailDelivered || localTelegramDelivered;
	await updateGrokSendCounter(
		user,
		supabase,
		stagedData.grokAllowed,
		localDelivered,
		currentTime,
		logger,
		"(staged daily)",
	);

	const emailRequired = stagedData.email !== null;
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
