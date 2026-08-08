import { DateTime, type DateTime as DateTimeType } from "luxon";
import { persistDailyNotificationNextSendAt } from "../daily-notification/schedule";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { resolveOutboundChannel } from "../messaging/delivery-channel";
import { shouldAdvanceScheduledNotificationSchedule } from "../schedule/delivery-terminal";
import { computeDeliveryRetryDelayMs } from "../schedule/retry-delays";
import type { DeliveryMethod } from "../scheduled-notifications/types";
import { toIsoOrThrow } from "../time/display";
import type { ScheduledSlotKey, UserRecord } from "../types";

/** True when the account's outbound channel is terminal for this digest slot. */
export async function shouldAdvanceDailyDigestSchedule(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		requiredChannel: DeliveryMethod | null;
	} & ScheduledSlotKey,
): Promise<boolean> {
	return shouldAdvanceScheduledNotificationSchedule({
		...options,
		notificationType: "daily",
	});
}

/**
 * Defer the digest without advancing to the next local day (processing failure before delivery).
 */
export async function deferDailyDigestProcessingRetry(options: {
	supabase: SupabaseAdminClient;
	user: UserRecord;
	logger: Logger;
	currentTime: DateTimeType;
	deferralCount: number;
}): Promise<void> {
	const { supabase, user, logger, currentTime, deferralCount } = options;

	const delayMs = computeDeliveryRetryDelayMs(deferralCount + 1);
	const retryAt = currentTime.plus({ milliseconds: delayMs });
	const retryAtIso = toIsoOrThrow(retryAt, "Failed to format digest retry time");

	await persistDailyNotificationNextSendAt({
		userId: user.id,
		supabase,
		logger,
		nextSendAtIso: retryAtIso,
	});

	logger.info("Deferred daily digest for retry", {
		action: "daily_run",
		userId: user.id,
		retryAtIso,
		deferralCount: deferralCount + 1,
		delayMs,
	});
}

/**
 * Record a processing failure before delivery (increments the active channel's slot attempt).
 */
export async function recordDailyDigestProcessingFailure(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		logger: Logger;
	} & ScheduledSlotKey,
): Promise<void> {
	const { supabase, user, scheduledDate, scheduledMinutes, logger } = options;
	const userId = user.id;
	const nowIso = toIsoOrThrow(DateTime.utc(), "Failed to format UTC ISO string");

	const { data: rows, error: selectError } = await supabase
		.from("scheduled_notifications")
		.select("channel, attempt_count")
		.eq("user_id", userId)
		.eq("notification_type", "daily")
		.eq("scheduled_date", scheduledDate)
		.eq("scheduled_minutes", scheduledMinutes);

	if (selectError) {
		logger.error(
			"Failed to read scheduled_notifications for processing failure",
			{ userId, scheduledDate, scheduledMinutes },
			selectError,
		);
		return;
	}

	const outbound = resolveOutboundChannel(user);
	if (!outbound) {
		logger.info("Skipping processing-failure row: no resolvable outbound channel", {
			userId,
			scheduledDate,
			scheduledMinutes,
			deliveryChannel: user.delivery_channel,
		});
		return;
	}
	const channel: DeliveryMethod = outbound;
	const existing = rows?.find((r) => r.channel === channel);
	const nextAttempt = (existing?.attempt_count ?? 0) + 1;
	const retryAt = DateTime.fromISO(nowIso, { zone: "utc" }).plus({
		milliseconds: computeDeliveryRetryDelayMs(nextAttempt),
	});
	const retryAtIso = retryAt.isValid ? retryAt.toISO() : null;

	if (existing) {
		const { error } = await supabase
			.from("scheduled_notifications")
			.update({
				status: "failed",
				attempt_count: nextAttempt,
				last_attempt_at: nowIso,
				error: "Daily digest processing failed",
				next_retry_at: retryAtIso,
			})
			.eq("user_id", userId)
			.eq("notification_type", "daily")
			.eq("scheduled_date", scheduledDate)
			.eq("scheduled_minutes", scheduledMinutes)
			.eq("channel", channel);
		if (error) {
			logger.error(
				"Failed to update scheduled_notifications after processing failure",
				{ userId, channel },
				error,
			);
		}
		return;
	}

	const { error } = await supabase.from("scheduled_notifications").insert({
		user_id: userId,
		notification_type: "daily",
		scheduled_date: scheduledDate,
		scheduled_minutes: scheduledMinutes,
		channel,
		status: "failed",
		attempt_count: 1,
		last_attempt_at: nowIso,
		error: "Daily digest processing failed",
		next_retry_at: retryAtIso,
	});
	if (error) {
		logger.error(
			"Failed to insert scheduled_notifications after processing failure",
			{ userId, channel },
			error,
		);
	}
}
