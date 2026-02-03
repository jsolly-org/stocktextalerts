import type { AppSupabaseClient } from "../../db/supabase";
import { recordNotification } from "../shared";
import type { ProcessingStats, SmsUser, UserStockRow } from "../types";
import { sendUserSms } from "./index";
import type { SmsSender } from "./twilio-utils";

export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	userStocks: UserStockRow[],
	stocksList: string,
	sendSms: SmsSender,
): Promise<ProcessingStats> {
	const messagePrefix = userStocks.length > 0 ? "Tracked: " : "";
	const optOutSuffix = ". Reply STOP to opt out.";

	// Calculate available length for stocks list
	// 160 is SMS character limit, but we need space for all prefixes and suffixes
	const fixedLength = messagePrefix.length + optOutSuffix.length;
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
	const smsMessage = `${messagePrefix}${truncatedStocksList}${optOutSuffix}`;

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
