import { shouldSendSms } from "../messaging/sms/index";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import type { ScheduledSlotKey } from "../types";
import type { UserRecord } from "../user-record-types";
import {
	type DeliveryMethod,
	MAX_NOTIFICATION_RETRIES,
	type ScheduledNotificationStatus,
	type ScheduledNotificationType,
	type SupabaseAdminClient,
} from "./helpers";

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
 * True when every required delivery channel for this slot is sent or retries are exhausted.
 * Failed channels with a future retry window remain non-terminal.
 */
export async function shouldAdvanceScheduledNotificationSchedule(
	options: {
		supabase: SupabaseAdminClient;
		user: UserRecord;
		notificationType: ScheduledNotificationType;
		emailRequired: boolean;
		smsRequired: boolean;
		telegramRequired?: boolean;
	} & ScheduledSlotKey,
): Promise<boolean> {
	const {
		supabase,
		user,
		notificationType,
		scheduledDate,
		scheduledMinutes,
		emailRequired,
		smsRequired,
		telegramRequired,
	} = options;

	if (emailRequired) {
		const email = await getChannelDeliveryState({
			supabase,
			userId: user.id,
			notificationType,
			scheduledDate,
			scheduledMinutes,
			channel: "email",
		});
		if (!channelDeliveryIsTerminal(email.status, email.attemptCount)) {
			return false;
		}
	}

	if (smsRequired && shouldSendSms(user)) {
		const sms = await getChannelDeliveryState({
			supabase,
			userId: user.id,
			notificationType,
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
		});
		if (!channelDeliveryIsTerminal(sms.status, sms.attemptCount)) {
			return false;
		}
	}

	if (telegramRequired && isTelegramChannelUsable(user)) {
		const telegram = await getChannelDeliveryState({
			supabase,
			userId: user.id,
			notificationType,
			scheduledDate,
			scheduledMinutes,
			channel: "telegram",
		});
		if (!channelDeliveryIsTerminal(telegram.status, telegram.attemptCount)) {
			return false;
		}
	}

	return true;
}
