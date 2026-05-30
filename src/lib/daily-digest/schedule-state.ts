import { DateTime, type DateTime as DateTimeType } from "luxon";
import type { Logger } from "../logging";
import { shouldSendSms } from "../messaging/sms/index";
import type { UserRecord } from "../messaging/types";
import { computeDeliveryRetryDelayMs } from "../providers/vendor-fault-tolerance";
import {
	getMaxDailyDigestSlotAttempts,
	MAX_NOTIFICATION_RETRIES,
	type SupabaseAdminClient,
} from "../schedule/helpers";
import { toIsoOrThrow } from "../time/format";

type ChannelStatus = "sent" | "failed" | "sending" | "missing";

async function getChannelStatus(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	scheduledDate: string;
	scheduledMinutes: number;
	channel: "email" | "sms";
}): Promise<{ status: ChannelStatus; attemptCount: number }> {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("status, attempt_count")
		.eq("user_id", options.userId)
		.eq("notification_type", "daily")
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel)
		.maybeSingle();

	if (error || !data) {
		return { status: "missing", attemptCount: 0 };
	}

	return {
		status: data.status as ChannelStatus,
		attemptCount: data.attempt_count,
	};
}

function channelIsTerminal(status: ChannelStatus, attemptCount: number): boolean {
	if (attemptCount >= MAX_NOTIFICATION_RETRIES) return true;
	if (status === "sent") return true;
	return false;
}

/**
 * True when every enabled delivery channel for this digest slot is sent or retries are exhausted.
 */
export async function shouldAdvanceDailyDigestSchedule(options: {
	supabase: SupabaseAdminClient;
	user: UserRecord;
	scheduledDate: string;
	scheduledMinutes: number;
	emailRequired: boolean;
	smsRequired: boolean;
}): Promise<boolean> {
	const { supabase, user, scheduledDate, scheduledMinutes, emailRequired, smsRequired } = options;

	if (emailRequired) {
		const email = await getChannelStatus({
			supabase,
			userId: user.id,
			scheduledDate,
			scheduledMinutes,
			channel: "email",
		});
		if (!channelIsTerminal(email.status, email.attemptCount)) {
			return false;
		}
	}

	if (smsRequired && shouldSendSms(user)) {
		const sms = await getChannelStatus({
			supabase,
			userId: user.id,
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
		});
		if (!channelIsTerminal(sms.status, sms.attemptCount)) {
			return false;
		}
	}

	return true;
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

	const { error } = await supabase
		.from("users")
		.update({ daily_digest_next_send_at: retryAtIso })
		.eq("id", user.id);

	if (error) {
		logger.error(
			"Failed to defer daily_digest_next_send_at after processing error",
			{ userId: user.id, retryAtIso, deferralCount },
			error,
		);
	} else {
		logger.info("Deferred daily digest for retry", {
			action: "daily_run",
			userId: user.id,
			retryAtIso,
			deferralCount: deferralCount + 1,
			delayMs,
		});
	}
}

/**
 * Record a processing failure before any channel delivery (increments slot attempt counters).
 */
export async function recordDailyDigestProcessingFailure(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	scheduledDate: string;
	scheduledMinutes: number;
	logger: Logger;
}): Promise<void> {
	const { supabase, userId, scheduledDate, scheduledMinutes, logger } = options;
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

	const channels: Array<"email" | "sms"> =
		rows && rows.length > 0
			? rows.map((r) => r.channel).filter((c): c is "email" | "sms" => c === "email" || c === "sms")
			: ["email"];

	for (const channel of channels) {
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
		} else {
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
	}
}

export { getMaxDailyDigestSlotAttempts, MAX_NOTIFICATION_RETRIES };
