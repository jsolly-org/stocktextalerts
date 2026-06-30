import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
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
	else if (channel === "sms") stats.smsFailed++;
	else stats.telegramFailed++;
}

function incrementChannelSuccess(
	channel: DeliveryMethod,
	stats: ScheduledNotificationTotals,
): void {
	if (channel === "email") stats.emailsSent++;
	else if (channel === "sms") stats.smsSent++;
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
