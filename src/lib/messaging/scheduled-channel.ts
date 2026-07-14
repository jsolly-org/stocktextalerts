import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import {
	consumeNotificationBudget,
	type NotificationBudgetKind,
	releaseNotificationBudget,
} from "../notification-budget";
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

/** Map scheduled claim types onto notification-budget kinds. */
export function scheduledTypeToBudgetKind(
	notificationType: ScheduledNotificationType,
): NotificationBudgetKind {
	if (notificationType === "market") {
		return "market_scheduled_asset_price";
	}
	// daily + standalone asset_events share the daily_notification global bucket
	return "daily_notification";
}

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
 * After a successful claim, reserve one budget unit.
 * - reserved → return true (caller should send)
 * - denied → terminal-skip as `sent` (no minute spin against an exhausted day)
 * - error → mark `failed` (retryable); do not pretend the budget was exhausted
 */
export async function reserveScheduledChannelBudget(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		logger: Logger;
		stats: ScheduledNotificationTotals;
		attemptCount: number;
	} & ScheduledSlotKey,
): Promise<boolean> {
	const kind = scheduledTypeToBudgetKind(options.notificationType);
	const consume = await consumeNotificationBudget(options.supabase, {
		userId: options.userId,
		kind,
	});
	if (consume.status === "reserved") {
		return true;
	}

	if (consume.status === "error") {
		incrementChannelFailure(options.channel, options.stats);
		options.logger.error(
			"Scheduled notification deferred: notification budget check failed",
			{
				userId: options.userId,
				notificationType: options.notificationType,
				channel: options.channel,
				scheduledDate: options.scheduledDate,
				scheduledMinutes: options.scheduledMinutes,
				kind,
			},
			new Error("notification_budget_check_failed"),
		);
		await updateScheduledNotificationRow({
			supabase: options.supabase,
			userId: options.userId,
			notificationType: options.notificationType,
			scheduledDate: options.scheduledDate,
			scheduledMinutes: options.scheduledMinutes,
			channel: options.channel,
			status: "failed",
			error: "notification_budget_check_failed",
			attemptCount: options.attemptCount,
			logger: options.logger,
		});
		return false;
	}

	options.stats.skipped++;
	options.logger.info("Scheduled notification skipped: notification budget exhausted", {
		userId: options.userId,
		notificationType: options.notificationType,
		channel: options.channel,
		scheduledDate: options.scheduledDate,
		scheduledMinutes: options.scheduledMinutes,
		kind,
	});

	const logged = await recordNotification(options.supabase, {
		user_id: options.userId,
		type: options.notificationType,
		delivery_method: options.channel,
		message_delivered: false,
		message: "Skipped: notification budget exhausted",
		error: "notification_budget_exhausted",
	});
	if (!logged) {
		options.stats.logFailures++;
	}

	// Terminal `sent` so shouldAdvance* advances next_send_at and we don't retry
	// every minute against an exhausted daily budget.
	await updateScheduledNotificationRow({
		supabase: options.supabase,
		userId: options.userId,
		notificationType: options.notificationType,
		scheduledDate: options.scheduledDate,
		scheduledMinutes: options.scheduledMinutes,
		channel: options.channel,
		status: "sent",
		attemptCount: options.attemptCount,
		logger: options.logger,
	});

	return false;
}

/** Refund a reserved scheduled-channel budget unit after a failed send. */
export async function releaseScheduledChannelBudget(
	supabase: SupabaseAdminClient,
	userId: string,
	notificationType: ScheduledNotificationType,
): Promise<void> {
	await releaseNotificationBudget(supabase, {
		userId,
		kind: scheduledTypeToBudgetKind(notificationType),
	});
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
		/** When set, release a previously reserved budget unit on sender-resolution failure. */
		budgetReserved?: boolean;
	} & ScheduledSlotKey,
): Promise<T | null> {
	try {
		return options.getSender();
	} catch (error) {
		if (options.budgetReserved) {
			await releaseScheduledChannelBudget(
				options.supabase,
				options.userId,
				options.notificationType,
			);
		}
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
	/** When true and success is false, refund the reserved budget unit. */
	budgetReserved?: boolean;
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
		budgetReserved,
	} = options;

	if (!success && budgetReserved) {
		await releaseScheduledChannelBudget(supabase, userId, notificationType);
	}

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
	/** When true and result.success is false, refund the reserved budget unit. */
	budgetReserved?: boolean;
}): Promise<void> {
	await completeScheduledChannelDelivery({
		...options,
		success: options.result.success,
		error: options.result.success ? undefined : options.result.error,
		logFields: deliveryResultToLogFields(options.result),
	});
}
