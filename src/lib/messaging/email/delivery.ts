import type { AppSupabaseClient } from "../../db/supabase";
import type { StockPriceMap } from "../../price-fetcher";
import { recordNotification } from "../shared";
import type { EmailUser, ProcessingStats, UserStockRow } from "../types";
import { sendUserEmail } from "./index";
import { type EmailSender, formatEmailMessage } from "./utils";

export async function processEmailUpdate(
	supabase: AppSupabaseClient,
	user: EmailUser,
	userStocks: UserStockRow[],
	stocksList: string,
	sendEmail: EmailSender,
	priceMap: StockPriceMap,
	marketOpen: boolean,
	idempotencyKey?: string,
): Promise<ProcessingStats> {
	const message = formatEmailMessage(
		user,
		userStocks,
		stocksList,
		priceMap,
		marketOpen,
	);
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
