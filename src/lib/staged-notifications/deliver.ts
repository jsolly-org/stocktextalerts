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
import {
	buildDelayBannerHtml,
	buildDelayBannerText,
	prependDelayBannerToEmail,
	prependDelayBannerToSms,
} from "../messaging/delay-banner";
import { sendUserEmail } from "../messaging/email/index";
import type { EmailSender } from "../messaging/email/utils";
import {
	deliveryResultToLogFields,
	recordNotification,
} from "../messaging/shared";
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

/** Deliver all staged notifications that are due (scheduled_for <= now). */
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
		logger.error(
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
			use_24_hour_time,
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
			daily_digest_include_prices_email,
			daily_digest_include_prices_sms,
			daily_digest_include_top_movers_email,
			daily_digest_include_top_movers_sms,
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
			market_asset_price_alerts_include_sms,
			price_move_alerts_include_sms,
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
		// Cast is intentionally narrow: the select above includes all fields required
		// by the downstream delivery helpers for staged notifications.
		(users ?? []).map((u) => [u.id, u as unknown as UserRecord]),
	);

	for (const row of allRows) {
		const user = userMap.get(row.user_id);
		if (!user) {
			logger.error("User not found for staged delivery, deleting row", {
				action: "staged_deliver",
				stagedId: row.id,
				userId: row.user_id,
			});
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
					deliveredUserTypes,
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
					deliveredUserTypes,
					stats,
				});
			}
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
		try {
			await deleteStagedNotification(supabase, row.id);
		} catch (error) {
			logger.error(
				"Failed to delete staged notification row after processing",
				{ action: "staged_deliver", stagedId: row.id, userId: row.user_id },
				error,
			);
		}
	}

	return { stats, deliveredUserTypes };
}

/** Deliver a single staged market-notification row. */
async function deliverStagedMarket(options: {
	row: StagedNotificationRow;
	stagedData: StagedMarketData;
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	sendEmail: EmailSender;
	getSmsSender: SmsSenderProvider;
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
		deliveredUserTypes,
		stats,
	} = options;
	const { scheduledDate, scheduledMinutes } = stagedData;
	const deliveredKey = `${row.user_id}:market`;

	// Detect delay for staged content delivered after scheduled time
	const scheduledFor = DateTime.fromISO(row.scheduled_for, { zone: "utc" });
	const delayBannerOpts = scheduledFor.isValid
		? {
				scheduledFor,
				now: currentTime,
				userTimezone: user.timezone,
				use24Hour: user.use_24_hour_time,
			}
		: null;
	const delayText = delayBannerOpts
		? buildDelayBannerText(delayBannerOpts)
		: null;
	const delayHtml = delayBannerOpts
		? buildDelayBannerHtml(delayBannerOpts)
		: null;

	// Email delivery
	if (stagedData.email) {
		const emailContent =
			delayText && delayHtml
				? prependDelayBannerToEmail(
						stagedData.email.text,
						stagedData.email.html,
						delayText,
						delayHtml,
					)
				: { text: stagedData.email.text, html: stagedData.email.html };

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
				{ text: emailContent.text, html: emailContent.html },
				sendEmail,
				idempotencyKey,
			);

			// IMPORTANT: mark this user/type as delivered immediately after a successful send
			// so fallback doesn't reprocess if later bookkeeping fails.
			if (result.success) {
				deliveredUserTypes.add(deliveredKey);
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "market",
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
			// Already claimed elsewhere → treat as delivered for fallback-skipping.
			deliveredUserTypes.add(deliveredKey);
			stats.skipped++;
		}
	}

	// SMS delivery
	if (stagedData.sms) {
		const smsMessage = delayText
			? prependDelayBannerToSms(stagedData.sms.message, delayText)
			: stagedData.sms.message;

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
					const result = await sendUserSms(user, smsMessage, sender, supabase);

					// Mark this user/type as delivered immediately after a successful send
					// so fallback doesn't reprocess if later bookkeeping fails.
					if (result.success) {
						deliveredUserTypes.add(deliveredKey);
					}

					const logged = await recordNotification(supabase, {
						user_id: user.id,
						type: "market",
						delivery_method: "sms",
						message_delivered: result.success,
						message: smsMessage,
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
				// Already claimed elsewhere → treat as delivered for fallback-skipping.
				deliveredUserTypes.add(deliveredKey);
				stats.skipped++;
			}
		}
	}

	// Advance next_send_at
	try {
		await updateUserMarketScheduledNextSendAt({
			user,
			supabase,
			logger,
			currentTime,
		});
	} catch (error) {
		logger.error(
			"Failed to advance next_send_at for staged market delivery",
			{ userId: user.id },
			error,
		);
	}
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
	getSmsSender: SmsSenderProvider;
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
		deliveredUserTypes,
		stats,
	} = options;
	const { scheduledDate, scheduledMinutes } = stagedData;
	const deliveredKey = `${row.user_id}:daily`;
	let localEmailDelivered = false;
	let localSmsDelivered = false;

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
	const dailyDelayText = dailyDelayOpts
		? buildDelayBannerText(dailyDelayOpts)
		: null;
	const dailyDelayHtml = dailyDelayOpts
		? buildDelayBannerHtml(dailyDelayOpts)
		: null;

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
			const idempotencyKey = `daily-digest/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
			const result = await sendUserEmail(
				user,
				stagedData.email.subject,
				{ text: emailContent.text, html: emailContent.html },
				sendEmail,
				idempotencyKey,
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
				logger,
			});
		} else if (claim.status === "claim_error") {
			stats.emailsFailed++;
		} else {
			// Already claimed elsewhere → treat as delivered for fallback-skipping.
			deliveredUserTypes.add(deliveredKey);
			stats.skipped++;
		}
	}

	// SMS delivery
	if (stagedData.sms) {
		const dailySmsMessage = dailyDelayText
			? prependDelayBannerToSms(stagedData.sms.message, dailyDelayText)
			: stagedData.sms.message;

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
						dailySmsMessage,
						sender,
						supabase,
					);

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
						message: dailySmsMessage,
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
				// Already claimed elsewhere → treat as delivered for fallback-skipping.
				deliveredUserTypes.add(deliveredKey);
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
	const localDelivered = localEmailDelivered || localSmsDelivered;
	if (stagedData.grokAllowed && localDelivered) {
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
	try {
		await updateUserDailyDigestNextSendAt({
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

	// Advance next_send_at for asset events if applicable
	if (stagedData.hasAnyAssetEventsOption) {
		try {
			await updateUserAssetEventsNextSendAt({
				user,
				supabase,
				logger,
				currentTime,
			});
		} catch (error) {
			logger.error(
				"Failed to advance asset_events next_send_at for staged daily delivery",
				{ userId: user.id },
				error,
			);
		}
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
