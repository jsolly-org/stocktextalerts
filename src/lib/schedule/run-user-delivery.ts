import type { Logger } from "../logging";
import { processEmailUpdate } from "../messaging/email/delivery";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { processSmsUpdate } from "../messaging/sms/delivery";
import type { UserRecord, UserStockRow } from "../messaging/types";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "./helpers";
import { logRetriesExhausted, updateScheduledNotificationRow } from "./helpers";
import type { SmsSenderProvider } from "./run-user-sms-sender";

export async function processScheduledUserEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userStocks: UserStockRow[];
	stocksList: string;
	sendEmail: EmailSender;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userStocks,
		stocksList,
		sendEmail,
		stats,
	} = options;

	const { data: claimed, error: claimError } = await supabase.rpc(
		"claim_scheduled_notification",
		{
			p_user_id: user.id,
			p_notification_type: "daily_digest",
			p_scheduled_date: scheduledDate,
			p_scheduled_minutes: scheduledMinutes,
			p_channel: "email",
		},
	);

	if (claimError) {
		logger.error(
			"Failed to claim scheduled notification (email)",
			{ userId: user.id },
			claimError,
		);
		stats.emailsFailed++;
		return;
	}

	if (!claimed) {
		await logRetriesExhausted({
			supabase,
			userId: user.id,
			notificationType: "daily_digest",
			scheduledDate,
			scheduledMinutes,
			channel: "email",
			logger,
		});
		stats.skipped++;
		return;
	}

	const emailIdempotencyKey = `daily-digest/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const { sent, logged, error } = await processEmailUpdate(
		supabase,
		user,
		userStocks,
		stocksList,
		sendEmail,
		emailIdempotencyKey,
	);

	if (sent) {
		stats.emailsSent++;
	} else {
		stats.emailsFailed++;
	}

	if (!logged) {
		stats.logFailures++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily_digest",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		status: sent ? "sent" : "failed",
		error,
		logger,
	});
}

export async function processScheduledUserSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userStocks: UserStockRow[];
	stocksList: string;
	getSmsSender: SmsSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userStocks,
		stocksList,
		getSmsSender,
		stats,
	} = options;

	const { data: claimed, error: claimError } = await supabase.rpc(
		"claim_scheduled_notification",
		{
			p_user_id: user.id,
			p_notification_type: "daily_digest",
			p_scheduled_date: scheduledDate,
			p_scheduled_minutes: scheduledMinutes,
			p_channel: "sms",
		},
	);

	if (claimError) {
		logger.error(
			"Failed to claim scheduled notification (sms)",
			{ userId: user.id },
			claimError,
		);
		stats.smsFailed++;
		return;
	}

	if (!claimed) {
		await logRetriesExhausted({
			supabase,
			userId: user.id,
			notificationType: "daily_digest",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			logger,
		});
		stats.skipped++;
		return;
	}

	const { sender: smsSender, error: smsError } = getSmsSender();
	if (!smsSender) {
		stats.smsFailed++;
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "daily_digest",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: smsError || "Twilio client not initialized",
			logger,
		});
		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "scheduled_update",
			delivery_method: "sms",
			message_delivered: false,
			message: "SMS service unavailable",
			error: smsError || "Twilio client not initialized",
		});
		if (!logged) {
			stats.logFailures++;
		}
		return;
	}

	const { sent, logged, error } = await processSmsUpdate(
		supabase,
		user,
		userStocks,
		stocksList,
		smsSender,
	);

	if (sent) {
		stats.smsSent++;
	} else {
		stats.smsFailed++;
	}

	if (!logged) {
		stats.logFailures++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily_digest",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: sent ? "sent" : "failed",
		error,
		logger,
	});
}
