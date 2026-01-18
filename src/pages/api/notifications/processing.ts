import type { AppSupabaseClient } from "../../../lib/supabase";
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
): Promise<ProcessingStats> {
	const message = formatEmailMessage(userStocks, stocksList);
	const result = await sendUserEmail(
		user,
		"Your Stock Update",
		message,
		sendEmail,
	);

	const logged = await recordNotification(supabase, {
		userId: user.id,
		type: "scheduled_update",
		deliveryMethod: "email",
		messageDelivered: result.success,
		message: message.text,
		error: result.success ? undefined : result.error,
		errorCode: result.success ? undefined : result.errorCode,
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
): Promise<ProcessingStats> {
	const messagePrefix = userStocks.length > 0 ? "Tracked: " : "";
	const optOutSuffix = ". Reply STOP to opt out.";
	const maxStocksListLength = 160 - messagePrefix.length - optOutSuffix.length;
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
	const smsMessage = `${messagePrefix}${truncatedStocksList}${optOutSuffix}`;

	const result = await sendUserSms(user, smsMessage, sendSms);

	const logged = await recordNotification(supabase, {
		userId: user.id,
		type: "scheduled_update",
		deliveryMethod: "sms",
		messageDelivered: result.success,
		message: smsMessage,
		error: result.success ? undefined : result.error,
		errorCode: result.success ? undefined : result.errorCode,
	});

	return {
		sent: result.success,
		logged,
		error: result.success ? undefined : result.error,
		errorCode: result.success ? undefined : result.errorCode,
	};
}
