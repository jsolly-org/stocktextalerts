/**
 * Delivery phase for pre-computed notifications.
 *
 * This module is the "send" side of the pre-compute/deliver pipeline. It reads
 * fully rendered content from `staged_notifications`, sends it via the same
 * email/SMS channels used by the normal pipeline, and handles all post-delivery
 * bookkeeping (claim idempotency, notifications_log, next_send_at advancement,
 * Grok counter updates, analyst month tracking).
 *
 * The delivery logic intentionally mirrors the existing delivery functions in
 * market-notifications/scheduled/delivery.ts and daily-digest/delivery.ts, but
 * operates on pre-rendered content instead of formatting on the spot.
 */

import { DateTime } from "luxon";
import { updateUserAssetEventsNextSendAt } from "../asset-events/next-send-at";
import { updateUserDailyDigestNextSendAt } from "../daily-digest/next-send-at";
import type { Logger } from "../logging";
import { updateUserMarketScheduledNextSendAt } from "../market-notifications/scheduled/next-send-at";
import { sendUserEmail } from "../messaging/email/index";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { UserRecord } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../schedule/helpers";
import {
	claimNotification,
	updateScheduledNotificationRow,
} from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import { toIsoOrThrow } from "../time/format";
import {
	deleteStagedNotification,
	fetchDueStagedNotifications,
	purgeStaleStaged,
} from "./db";
import type {
	StagedDailyData,
	StagedMarketData,
	StagedNotificationRow,
} from "./types";

const STALE_MAX_AGE_MINUTES = 5;

/**
 * Deliver all staged notifications that are due (scheduled_for <= now).
 *
 * Returns combined stats and the set of user IDs that were delivered from staging
 * (so the fallback path can skip them).
 */
export async function deliverStagedNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
}): Promise<{
	stats: ScheduledNotificationTotals;
	deliveredUserTypes: Set<string>;
}> {
	const { supabase, logger, currentTime, sendEmail, getSmsSender } = options;

	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	};

	// Track which user+type combos were delivered via staging so fallback can skip them
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
		logger.warn(
			"Failed to purge stale staged notifications",
			{ action: "staged_deliver" },
			error,
		);
	}

	const currentTimeIso = toIsoOrThrow(
		currentTime,
		"Failed to format currentTime ISO",
	);

	// Fetch due staged rows for both types
	let marketRows: StagedNotificationRow[] = [];
	let dailyRows: StagedNotificationRow[] = [];
	try {
		[marketRows, dailyRows] = await Promise.all([
			fetchDueStagedNotifications(supabase, {
				cutoffTimeIso: currentTimeIso,
				notificationType: "market",
			}),
			fetchDueStagedNotifications(supabase, {
				cutoffTimeIso: currentTimeIso,
				notificationType: "daily",
			}),
		]);
	} catch (error) {
		logger.error(
			"Failed to fetch due staged notifications",
			{ action: "staged_deliver" },
			error,
		);
		return { stats, deliveredUserTypes };
	}

	const allRows = [...marketRows, ...dailyRows];
	if (allRows.length === 0) {
		return { stats, deliveredUserTypes };
	}

	// Batch-fetch user records
	const userIds = [...new Set(allRows.map((r) => r.user_id))];
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
			market_scheduled_asset_price_enabled,
			market_scheduled_asset_price_include_email,
			market_scheduled_asset_price_include_sms,
			market_scheduled_asset_price_times,
			daily_digest_time,
			daily_digest_next_send_at,
			market_scheduled_asset_price_next_send_at,
			email_notifications_enabled,
			sms_notifications_enabled,
			sms_opted_out,
			show_sparklines,
			daily_digest_include_news_email,
			daily_digest_include_rumors_email,
			asset_events_include_calendar_email,
			asset_events_include_calendar_sms,
			asset_events_include_ipo_email,
			asset_events_include_ipo_sms,
			asset_events_include_analyst_email,
			asset_events_include_analyst_sms,
			asset_events_include_insider_email,
			asset_events_include_insider_sms,
			asset_events_next_send_at,
			asset_events_last_analyst_sent_month,
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

	const userMap = new Map(
		(users ?? []).map((u) => [u.id, u as unknown as UserRecord]),
	);

	for (const row of allRows) {
		const user = userMap.get(row.user_id);
		if (!user) {
			logger.warn("User not found for staged delivery, deleting row", {
				action: "staged_deliver",
				stagedId: row.id,
				userId: row.user_id,
			});
			await deleteStagedNotification(supabase, row.id);
			continue;
		}

		try {
			if (row.notification_type === "market") {
				await deliverStagedMarket({
					row,
					stagedData: row.staged_data as StagedMarketData,
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
					stats,
				});
			} else {
				await deliverStagedDaily({
					row,
					stagedData: row.staged_data as StagedDailyData,
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
					stats,
				});
			}

			deliveredUserTypes.add(`${row.user_id}:${row.notification_type}`);
		} catch (error) {
			logger.error(
				"Error delivering staged notification",
				{
					action: "staged_deliver",
					stagedId: row.id,
					userId: row.user_id,
					type: row.notification_type,
				},
				error,
			);
			stats.skipped++;
		}

		// Always delete the staged row after processing (success or failure)
		await deleteStagedNotification(supabase, row.id);
	}

	return { stats, deliveredUserTypes };
}

async function deliverStagedMarket(options: {
	row: StagedNotificationRow;
	stagedData: StagedMarketData;
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		stagedData,
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		stats,
	} = options;
	const { scheduledDate, scheduledMinutes } = stagedData;

	// Email delivery
	if (stagedData.email) {
		const claim = await claimNotification({
			supabase,
			userId: user.id,
			notificationType: "market",
			scheduledDate,
			scheduledMinutes,
			channel: "email",
			logger,
		});

		if (claim.status === "claimed") {
			const idempotencyKey = `scheduled-update/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
			const result = await sendUserEmail(
				user,
				stagedData.email.subject,
				{ text: stagedData.email.text, html: stagedData.email.html },
				sendEmail,
				idempotencyKey,
			);

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "market",
				delivery_method: "email",
				message_delivered: result.success,
				message: stagedData.email.text,
				error: result.success ? undefined : result.error,
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
				notificationType: "market",
				scheduledDate,
				scheduledMinutes,
				channel: "email",
				status: result.success ? "sent" : "failed",
				error: result.success ? undefined : result.error,
				logger,
			});
		} else if (claim.status === "claim_error") {
			stats.emailsFailed++;
		} else {
			stats.skipped++;
		}
	}

	// SMS delivery
	if (stagedData.sms) {
		const smsEnabled = shouldSendSms(user);
		if (smsEnabled) {
			const claim = await claimNotification({
				supabase,
				userId: user.id,
				notificationType: "market",
				scheduledDate,
				scheduledMinutes,
				channel: "sms",
				logger,
			});

			if (claim.status === "claimed") {
				try {
					const { sender } = getSmsSender();
					const result = await sendUserSms(
						user,
						stagedData.sms.message,
						sender,
					);

					const logged = await recordNotification(supabase, {
						user_id: user.id,
						type: "market",
						delivery_method: "sms",
						message_delivered: result.success,
						message: stagedData.sms.message,
						error: result.success ? undefined : result.error,
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
						notificationType: "market",
						scheduledDate,
						scheduledMinutes,
						channel: "sms",
						status: result.success ? "sent" : "failed",
						error: result.success ? undefined : result.error,
						logger,
					});
				} catch (error) {
					stats.smsFailed++;
					logger.error(
						"Failed to resolve SMS sender for staged market delivery",
						{ userId: user.id },
						error,
					);
				}
			} else if (claim.status === "claim_error") {
				stats.smsFailed++;
			} else {
				stats.skipped++;
			}
		}
	}

	// Advance next_send_at
	await updateUserMarketScheduledNextSendAt({
		user,
		supabase,
		logger,
		currentTime,
	});
}

async function deliverStagedDaily(options: {
	row: StagedNotificationRow;
	stagedData: StagedDailyData;
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		stagedData,
		user,
		supabase,
		logger,
		currentTime,
		sendEmail,
		getSmsSender,
		stats,
	} = options;
	const { scheduledDate, scheduledMinutes } = stagedData;

	// Email delivery
	if (stagedData.email) {
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
			const idempotencyKey = `daily-digest/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
			const result = await sendUserEmail(
				user,
				stagedData.email.subject,
				{ text: stagedData.email.text, html: stagedData.email.html },
				sendEmail,
				idempotencyKey,
			);

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "daily",
				delivery_method: "email",
				message_delivered: result.success,
				message: stagedData.email.text,
				error: result.success ? undefined : result.error,
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
				logger,
			});
		} else if (claim.status === "claim_error") {
			stats.emailsFailed++;
		} else {
			stats.skipped++;
		}
	}

	// SMS delivery
	if (stagedData.sms) {
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
					const result = await sendUserSms(
						user,
						stagedData.sms.message,
						sender,
					);

					const logged = await recordNotification(supabase, {
						user_id: user.id,
						type: "daily",
						delivery_method: "sms",
						message_delivered: result.success,
						message: stagedData.sms.message,
						error: result.success ? undefined : result.error,
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
						logger,
					});
				} catch (error) {
					stats.smsFailed++;
					logger.error(
						"Failed to resolve SMS sender for staged daily delivery",
						{ userId: user.id },
						error,
					);
				}
			} else if (claim.status === "claim_error") {
				stats.smsFailed++;
			} else {
				stats.skipped++;
			}
		}
	}

	// Post-delivery: Grok counter update.
	// This replicates the updateGrokSendCounter logic from daily-digest/process.ts
	// inline rather than importing it, because that function is tightly coupled to
	// the ScheduledNotificationTotals stats object and would create a circular
	// dependency. The logic is straightforward: reset the rolling window if expired,
	// otherwise increment the counter.
	const anyDelivered = stats.emailsSent > 0 || stats.smsSent > 0;
	if (stagedData.grokAllowed && anyDelivered) {
		const GROK_WINDOW_HOURS = 24;
		const now = currentTime.toISO();
		if (now) {
			const windowStart = user.grok_window_start
				? DateTime.fromISO(user.grok_window_start, { zone: "utc" })
				: null;
			const windowExpired =
				!windowStart?.isValid ||
				currentTime.diff(windowStart, "hours").hours >= GROK_WINDOW_HOURS;

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

	// Advance next_send_at for daily digest
	await updateUserDailyDigestNextSendAt({
		user,
		supabase,
		logger,
		currentTime,
	});

	// Advance next_send_at for asset events if applicable
	if (stagedData.hasAnyAssetEventsOption) {
		await updateUserAssetEventsNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});
	}

	// Update analyst sent month if applicable
	if (stagedData.shouldUpdateAnalyst && stagedData.analystMonth) {
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
