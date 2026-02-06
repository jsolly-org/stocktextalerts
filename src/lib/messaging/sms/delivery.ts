import type { AppSupabaseClient } from "../../db/supabase";
import { recordNotification } from "../shared";
import type { ProcessingStats, SmsUser, UserStockRow } from "../types";
import { sendUserSms } from "./index";
import type { SmsSender } from "./twilio-utils";

export function formatSmsMessage(
	userStocks: UserStockRow[],
	stocksList: string,
	marketOpen: boolean,
): string {
	const optOutSuffix = "Reply STOP to opt out.";
	if (userStocks.length === 0) {
		return `${stocksList}. ${optOutSuffix}`;
	}
	const marketDisclaimer = marketOpen
		? ""
		: "Prices as of last market close.\n";
	return `${stocksList}\n\n${marketDisclaimer}${optOutSuffix}`;
}

export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	userStocks: UserStockRow[],
	stocksList: string,
	sendSms: SmsSender,
	marketOpen: boolean,
): Promise<ProcessingStats> {
	const smsMessage = formatSmsMessage(userStocks, stocksList, marketOpen);

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
