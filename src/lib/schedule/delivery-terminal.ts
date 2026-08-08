import type { SupabaseAdminClient } from "../db/supabase";
import { MAX_NOTIFICATION_RETRIES } from "../scheduled-notifications/constants";
import type {
	DeliveryMethod,
	ScheduledNotificationStatus,
	ScheduledNotificationType,
} from "../scheduled-notifications/types";
import type { ScheduledSlotKey, UserRecord } from "../types";

async function getChannelDeliveryState(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
	} & ScheduledSlotKey,
): Promise<{ status: ScheduledNotificationStatus | null; attemptCount: number }> {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("status, attempt_count")
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel)
		.maybeSingle();

	if (error || !data) {
		return { status: null, attemptCount: 0 };
	}

	return {
		status: data.status,
		attemptCount: data.attempt_count,
	};
}

function channelDeliveryIsTerminal(
	status: ScheduledNotificationStatus | null,
	attemptCount: number,
): boolean {
	if (attemptCount >= MAX_NOTIFICATION_RETRIES) {
		return true;
	}
	if (status === "sent") {
		return true;
	}
	return false;
}

/**
 * True when the single required outbound channel for this slot is sent or
 * retries are exhausted. Pass `requiredChannel: null` when nothing was
 * attempted (no content / disabled) — schedule may advance.
 */
export async function shouldAdvanceScheduledNotificationSchedule(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		notificationType: ScheduledNotificationType;
		/** The one account delivery pipe that was (or would be) used for this slot. */
		requiredChannel: DeliveryMethod | null;
	} & ScheduledSlotKey,
): Promise<boolean> {
	const { supabase, user, notificationType, scheduledDate, scheduledMinutes, requiredChannel } =
		options;

	if (requiredChannel == null) {
		return true;
	}

	const state = await getChannelDeliveryState({
		supabase,
		userId: user.id,
		notificationType,
		scheduledDate,
		scheduledMinutes,
		channel: requiredChannel,
	});
	return channelDeliveryIsTerminal(state.status, state.attemptCount);
}
