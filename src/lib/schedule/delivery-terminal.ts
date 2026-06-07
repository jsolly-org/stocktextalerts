import { shouldSendSms } from "../messaging/sms/index";
import type { UserRecord } from "../messaging/types";
import { MAX_NOTIFICATION_RETRIES, type SupabaseAdminClient } from "./helpers";

type ScheduledNotificationType = "market" | "daily" | "asset_events";
type ChannelStatus = "sent" | "failed" | "sending" | "missing";

async function getChannelStatus(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	scheduledMinutes: number;
	channel: "email" | "sms";
}): Promise<{ status: ChannelStatus; attemptCount: number }> {
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
		return { status: "missing", attemptCount: 0 };
	}

	return {
		status: data.status as ChannelStatus,
		attemptCount: data.attempt_count,
	};
}

function channelIsTerminal(status: ChannelStatus, attemptCount: number): boolean {
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
export async function shouldAdvanceScheduledNotificationSchedule(options: {
	supabase: SupabaseAdminClient;
	user: UserRecord;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	scheduledMinutes: number;
	emailRequired: boolean;
	smsRequired: boolean;
}): Promise<boolean> {
	const {
		supabase,
		user,
		notificationType,
		scheduledDate,
		scheduledMinutes,
		emailRequired,
		smsRequired,
	} = options;

	if (emailRequired) {
		const email = await getChannelStatus({
			supabase,
			userId: user.id,
			notificationType,
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
			notificationType,
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
