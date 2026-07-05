import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import {
	claimNotification,
	updateScheduledNotificationRow,
} from "../scheduled-notifications/store";
import type {
	DeliveryMethod,
	ScheduledNotificationTotals,
	ScheduledNotificationType,
} from "../scheduled-notifications/types";
import type { DeliveryResult, IsoDateString, MinuteOfDay, ScheduledSlotKey } from "../types";
import { deliveryResultToLogFields, recordNotification } from "./shared";

type ClaimResult = Awaited<ReturnType<typeof claimNotification>>;

function incrementChannelFailure(
	channel: DeliveryMethod,
	stats: ScheduledNotificationTotals,
): void {
	if (channel === "email") stats.emailsFailed++;
	else stats.telegramFailed++;
}

function incrementChannelSuccess(
	channel: DeliveryMethod,
	stats: ScheduledNotificationTotals,
): void {
	if (channel === "email") stats.emailsSent++;
	else stats.telegramSent++;
}

/**
 * Apply claim outcome to stats. Returns the post-claim attempt count when delivery
 * should proceed, or null when the channel should be skipped or treated as failed.
 */
function resolveScheduledClaim(
	claim: ClaimResult,
	channel: DeliveryMethod,
	stats: ScheduledNotificationTotals,
): number | null {
	if (claim.status === "claim_error") {
		incrementChannelFailure(channel, stats);
		return null;
	}
	if (claim.status === "retries_exhausted" || claim.status === "not_ready") {
		stats.skipped++;
		return null;
	}
	return claim.attemptCount;
}

/** Claim a scheduled notification slot and update stats on denial. */
export async function claimScheduledChannel(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		logger: Logger;
		stats: ScheduledNotificationTotals;
	} & ScheduledSlotKey,
): Promise<number | null> {
	const claim = await claimNotification(options);
	return resolveScheduledClaim(claim, options.channel, options.stats);
}

/**
 * Resolve a channel sender inside a claimed scheduled slot.
 *
 * On factory throw: bumps the channel failure stat, logs the resolution error, and
 * marks the scheduled_notifications row failed. A sender that never initialized
 * built/sent no message, so it does NOT get a notification_log row (which records
 * actual message sends) — the failed row + error log are the record. Returns null
 * when the caller should skip the channel.
 */
export async function resolveScheduledSender<T>(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		logger: Logger;
		stats: ScheduledNotificationTotals;
		attemptCount: number;
		getSender: () => T;
		/** Pipeline-specific error message, e.g. "Failed to resolve email sender for daily digest". */
		logMessage: string;
	} & ScheduledSlotKey,
): Promise<T | null> {
	try {
		return options.getSender();
	} catch (error) {
		incrementChannelFailure(options.channel, options.stats);
		options.logger.error(
			options.logMessage,
			{
				userId: options.userId,
				scheduledDate: options.scheduledDate,
				scheduledMinutes: options.scheduledMinutes,
			},
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase: options.supabase,
			userId: options.userId,
			notificationType: options.notificationType,
			scheduledDate: options.scheduledDate,
			scheduledMinutes: options.scheduledMinutes,
			channel: options.channel,
			status: "failed",
			error: extractErrorMessage(error),
			attemptCount: options.attemptCount,
			logger: options.logger,
		});
		return null;
	}
}

/** Record delivery outcome, bump stats, and update the scheduled_notifications row. */
async function completeScheduledChannelDelivery(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	channel: DeliveryMethod;
	logger: Logger;
	stats: ScheduledNotificationTotals;
	attemptCount: number;
	success: boolean;
	error?: string;
	logMessage: string;
	logFields?: Partial<ReturnType<typeof deliveryResultToLogFields>>;
}): Promise<void> {
	const {
		supabase,
		userId,
		notificationType,
		scheduledDate,
		scheduledMinutes,
		channel,
		logger,
		stats,
		attemptCount,
		success,
		error,
		logMessage,
		logFields,
	} = options;

	const logged = await recordNotification(supabase, {
		user_id: userId,
		type: notificationType,
		delivery_method: channel,
		message_delivered: success,
		message: logMessage,
		...(logFields ?? {}),
	});
	if (!logged) {
		stats.logFailures++;
	}

	if (success) {
		incrementChannelSuccess(channel, stats);
	} else {
		incrementChannelFailure(channel, stats);
	}

	await updateScheduledNotificationRow({
		supabase,
		userId,
		notificationType,
		scheduledDate,
		scheduledMinutes,
		channel,
		status: success ? "sent" : "failed",
		error: success ? undefined : error,
		attemptCount,
		logger,
	});
}

/** Convenience when the send path already produced a `DeliveryResult`. */
export async function completeScheduledChannelFromResult(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
	channel: DeliveryMethod;
	logger: Logger;
	stats: ScheduledNotificationTotals;
	attemptCount: number;
	result: DeliveryResult;
	logMessage: string;
}): Promise<void> {
	await completeScheduledChannelDelivery({
		...options,
		success: options.result.success,
		error: options.result.success ? undefined : options.result.error,
		logFields: deliveryResultToLogFields(options.result),
	});
}
