import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { processEmailUpdate } from "../messaging/email/delivery";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import { processSmsUpdate } from "../messaging/sms/delivery";
import type {
	FormatPreferences,
	UserRecord,
	UserStockRow,
} from "../messaging/types";
import type { StockPriceMap } from "../price-fetcher";
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
	priceMap: StockPriceMap;
	marketOpen: boolean;
	stats: ScheduledNotificationTotals;
	formatPrefs?: FormatPreferences;
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
		priceMap,
		marketOpen,
		stats,
		formatPrefs,
	} = options;

	const { data: claimed, error: claimError } = await supabase.rpc(
		"claim_scheduled_notification",
		{
			p_user_id: user.id,
			p_notification_type: "scheduled_update",
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
			notificationType: "scheduled_update",
			scheduledDate,
			scheduledMinutes,
			channel: "email",
			logger,
		});
		stats.skipped++;
		return;
	}

	const emailIdempotencyKey = `scheduled-update/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const { sent, logged, error } = await processEmailUpdate(
		supabase,
		user,
		userStocks,
		stocksList,
		sendEmail,
		priceMap,
		marketOpen,
		emailIdempotencyKey,
		formatPrefs,
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
		notificationType: "scheduled_update",
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
	marketOpen: boolean;
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
		marketOpen,
		stats,
	} = options;

	const { data: claimed, error: claimError } = await supabase.rpc(
		"claim_scheduled_notification",
		{
			p_user_id: user.id,
			p_notification_type: "scheduled_update",
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
			notificationType: "scheduled_update",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			logger,
		});
		stats.skipped++;
		return;
	}

	let smsSenderResult: ReturnType<SmsSenderProvider>;
	try {
		smsSenderResult = getSmsSender();
	} catch (error) {
		stats.smsFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve SMS sender",
			{
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				channel: "sms",
				errorMessage,
				stats,
			},
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "scheduled_update",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			logger,
		});

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "scheduled_update",
			delivery_method: "sms",
			message_delivered: false,
			message: "SMS service unavailable",
			error: errorMessage,
		});
		if (!logged) {
			stats.logFailures++;
		}

		return;
	}
	const smsSender = smsSenderResult.sender;

	const { sent, logged, error } = await processSmsUpdate(
		supabase,
		user,
		userStocks,
		stocksList,
		smsSender,
		marketOpen,
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
		notificationType: "scheduled_update",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: sent ? "sent" : "failed",
		error,
		logger,
	});
}
