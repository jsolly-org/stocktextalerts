import type { AppSupabaseClient } from "../../../lib/db/supabase";
import { sendUserEmail } from "./email";
import { type EmailSender, formatEmailMessage } from "./email/utils";
import {
	type EmailUser,
	recordNotification,
	type SmsUser,
	type UserStockRow,
} from "./shared";
import { sendUserSms } from "./sms";
import type { SmsSender } from "./sms/twilio-utils";

interface ProcessingStats {
	sent: boolean;
	logged: boolean;
	error?: string;
	errorCode?: string;
}

export async function processEmailUpdate(
	supabase: AppSupabaseClient,
	user: EmailUser,
	userStocks: UserStockRow[],
	stocksList: string,
	sendEmail: EmailSender,
	idempotencyKey?: string,
	isPreview = false,
): Promise<ProcessingStats> {
	const message = formatEmailMessage(userStocks, stocksList, isPreview);
	const result = await sendUserEmail(
		user,
		"Your Stock Update",
		message,
		sendEmail,
		idempotencyKey,
	);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "scheduled_update",
		delivery_method: "email",
		message_delivered: result.success,
		message: message.text,
		error: result.success ? undefined : result.error,
		error_code: result.success ? undefined : result.errorCode,
	});

	return {
		sent: result.success,
		logged,
		error: result.success ? undefined : result.error,
		errorCode: result.success ? undefined : result.errorCode,
	};
}

export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	userStocks: UserStockRow[],
	stocksList: string,
	sendSms: SmsSender,
	isPreview = false,
): Promise<ProcessingStats> {
	const senderName = "Stock Text Alerts";
	const previewPrefix = isPreview ? "[PREVIEW] " : "";
	const messagePrefix = userStocks.length > 0 ? "Tracked: " : "";
	const optOutSuffix = ". Reply STOP to opt out.";
	const previewSuffix = isPreview
		? ` From ${senderName}. Preview only, not scheduled.`
		: "";

	// Calculate available length for stocks list
	// 160 is SMS character limit, but we need space for all prefixes and suffixes
	const fixedLength =
		previewPrefix.length +
		messagePrefix.length +
		optOutSuffix.length +
		previewSuffix.length;
	const maxStocksListLength = 160 - fixedLength;

	let truncatedStocksList = stocksList;
	if (stocksList.length > maxStocksListLength) {
		// Truncate at the last comma boundary to avoid cutting mid-word or mid-symbol
		// (e.g., "AAPL - Apple Inc" should not become "AAPL - App...")
		const cutoff = stocksList.lastIndexOf(", ", maxStocksListLength - 3);
		truncatedStocksList =
			cutoff > 0
				? `${stocksList.substring(0, cutoff)}...`
				: `${stocksList.substring(0, maxStocksListLength - 3)}...`;
	}
	const smsMessage = `${previewPrefix}${messagePrefix}${truncatedStocksList}${optOutSuffix}${previewSuffix}`;

	const result = await sendUserSms(user, smsMessage, sendSms);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "scheduled_update",
		delivery_method: "sms",
		message_delivered: result.success,
		message: smsMessage,
		error: result.success ? undefined : result.error,
		error_code: result.success ? undefined : result.errorCode,
	});

	return {
		sent: result.success,
		logged,
		error: result.success ? undefined : result.error,
		errorCode: result.success ? undefined : result.errorCode,
	};
}
