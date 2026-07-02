import { DateTime } from "luxon";
import type { Database } from "../db/generated/database.types";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { recordNotification } from "../messaging/shared";
import { computeDeliveryRetryDelayMs } from "../schedule/retry-delays";
import { toIsoOrThrow } from "../time/display";
import type { ScheduledSlotKey } from "../types";
import { MAX_NOTIFICATION_RETRIES } from "./constants";
import type {
	DeliveryMethod,
	ScheduledNotificationStatus,
	ScheduledNotificationType,
} from "./types";

/** Read attempt_count for a scheduled notification row (0 when missing). */
async function getScheduledNotificationAttemptCount(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
	} & ScheduledSlotKey,
): Promise<number> {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("attempt_count")
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel)
		.maybeSingle();

	if (error || !data) return 0;
	return data.attempt_count;
}

/** Max attempt_count across channels for a daily digest slot. */
export async function getMaxDailyDigestSlotAttempts(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
	} & ScheduledSlotKey,
): Promise<number> {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("attempt_count")
		.eq("user_id", options.userId)
		.eq("notification_type", "daily")
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes);

	if (error || !data || data.length === 0) return 0;
	return data.reduce((max, row) => Math.max(max, row.attempt_count), 0);
}

/**
 * Update the status/error fields for a specific scheduled notification row.
 *
 * This is keyed by the composite uniqueness of:
 * user + notification type + scheduled date/minutes + channel.
 */
export async function updateScheduledNotificationRow(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		status: Extract<ScheduledNotificationStatus, "sent" | "failed">;
		error?: string;
		/** Post-claim attempt_count from claimNotification — when provided, skips the re-SELECT
		 *  the failed branch would otherwise do to compute the backoff. */
		attemptCount?: number;
		logger: Logger;
	} & ScheduledSlotKey,
) {
	const nowIso = toIsoOrThrow(DateTime.utc(), "Failed to format UTC ISO string");
	let update: Database["public"]["Tables"]["scheduled_notifications"]["Update"];
	if (options.status === "sent") {
		update = {
			status: "sent",
			sent_at: nowIso,
			error: null,
			next_retry_at: null,
		};
	} else {
		const attemptCount =
			options.attemptCount ?? (await getScheduledNotificationAttemptCount(options));
		const retryAt = DateTime.fromISO(nowIso, { zone: "utc" }).plus({
			milliseconds: computeDeliveryRetryDelayMs(attemptCount),
		});
		const retryAtIso = retryAt.isValid ? retryAt.toISO() : null;
		update = {
			status: "failed",
			error: options.error ?? "Unknown error",
			next_retry_at: retryAtIso,
		};
	}

	const { error } = await options.supabase
		.from("scheduled_notifications")
		.update(update)
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel);

	if (error) {
		options.logger.error(
			"Failed to update scheduled_notifications row",
			{ userId: options.userId, channel: options.channel },
			error,
		);
	}
}

type ClaimResult =
	/** Claimed; `attemptCount` is the post-claim count the RPC just set (>= 1), threaded to
	 *  `updateScheduledNotificationRow` so the failure path needn't re-read it. */
	| { status: "claimed"; attemptCount: number }
	| { status: "claim_error" }
	| { status: "retries_exhausted" }
	| { status: "not_ready" };

/**
 * Claim a scheduled notification via the `claim_scheduled_notification` RPC.
 *
 * Encapsulates the RPC call, error logging, and retries-exhaustion recording so
 * delivery functions can replace ~25 lines of boilerplate with a single call.
 */
export async function claimNotification(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		logger: Logger;
	} & ScheduledSlotKey,
): Promise<ClaimResult> {
	const { supabase, userId, notificationType, scheduledDate, scheduledMinutes, channel, logger } =
		options;

	const { data: claimedRaw, error: claimError } = await supabase.rpc(
		"claim_scheduled_notification",
		{
			p_user_id: userId,
			p_notification_type: notificationType,
			p_scheduled_date: scheduledDate,
			p_scheduled_minutes: scheduledMinutes,
			p_channel: channel,
		},
	);

	if (claimError) {
		logger.error(
			`Failed to claim ${notificationType} notification (${channel})`,
			{ userId },
			claimError,
		);
		return { status: "claim_error" };
	}

	// The RPC returns the post-claim attempt_count (>= 1) when this run won the claim, or NULL
	// when denied (already sent / retries exhausted / not yet due per the backoff).
	const claimedAttemptCount = typeof claimedRaw === "number" ? claimedRaw : null;
	if (claimedAttemptCount === null) {
		const { data: row, error: rowError } = await supabase
			.from("scheduled_notifications")
			.select("attempt_count, status")
			.eq("user_id", userId)
			.eq("notification_type", notificationType)
			.eq("scheduled_date", scheduledDate)
			.eq("scheduled_minutes", scheduledMinutes)
			.eq("channel", channel)
			.maybeSingle();

		if (rowError) {
			logger.error(
				`Failed to read ${notificationType} notification row after claim denied (${channel})`,
				{ userId },
				rowError,
			);
			return { status: "claim_error" };
		}

		if (row && row.attempt_count >= MAX_NOTIFICATION_RETRIES) {
			await logRetriesExhausted({
				supabase,
				userId,
				notificationType,
				scheduledDate,
				scheduledMinutes,
				channel,
				logger,
			});
			return { status: "retries_exhausted" };
		}

		return { status: "not_ready" };
	}

	return { status: "claimed", attemptCount: claimedAttemptCount };
}

/**
 * Record that retries were exhausted for a scheduled notification, and write a log row.
 *
 * This is used as a backstop so we can track delivery failures without spamming retries
 * within a single run.
 */
async function logRetriesExhausted(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		logger: Logger;
	} & ScheduledSlotKey,
) {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("attempt_count,status")
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel)
		.maybeSingle();

	if (error) {
		options.logger.error(
			"Failed to fetch scheduled_notifications row",
			{ userId: options.userId, channel: options.channel },
			error,
		);
		return;
	}

	if (!data || data.status === "sent") {
		return;
	}

	if (data.attempt_count >= MAX_NOTIFICATION_RETRIES) {
		// Terminal delivery failure for today (any cause: Twilio outage, DB
		// error, sustained rate limit). Next-day cron tick reattempts, but
		// the user missed today's notification — alarm should see this.
		options.logger.error(
			"Retries exhausted; will retry next local day",
			{ userId: options.userId, channel: options.channel },
			new Error(`scheduled_notifications attempt_count >= ${MAX_NOTIFICATION_RETRIES}`),
		);

		await recordNotification(options.supabase, {
			user_id: options.userId,
			type: options.notificationType,
			delivery_method: options.channel,
			message_delivered: false,
			message: "Retries exhausted; will retry next local day",
			error: `scheduled_notifications attempt_count >= ${MAX_NOTIFICATION_RETRIES}`,
		});
	}
}
