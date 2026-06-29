import type { AppSupabaseClient } from "../../db/supabase";
import type { AssetPriceMap, MarketSession, ProcessingStats, UserAssetRow } from "../../types";
import { formatMarketScheduledEmail } from "../notifications/market-scheduled";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { EmailFormatContext, EmailUser } from "../types";
import { sendUserEmail } from "./index";
import type { EmailSender } from "./utils";

/**
 * Format + send a scheduled email update for a user, then record the delivery outcome.
 */
export async function processEmailUpdate(
	supabase: AppSupabaseClient,
	user: EmailUser,
	userAssets: UserAssetRow[],
	assetsList: string,
	sendEmail: EmailSender,
	priceMap: AssetPriceMap,
	marketSession: MarketSession,
	context?: EmailFormatContext,
	delayBanners?: { text?: string | null; html?: string | null },
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	},
	noSessionTrade?: Set<string>,
): Promise<ProcessingStats> {
	const message = formatMarketScheduledEmail(
		user,
		userAssets,
		assetsList,
		priceMap,
		marketSession,
		context,
		delayBanners,
		sessionFirstLine,
		noSessionTrade,
	);
	const result = await sendUserEmail(user, "Your Scheduled Price Notification", message, sendEmail);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "market",
		delivery_method: "email",
		message_delivered: result.success,
		message: message.text,
		...deliveryResultToLogFields(result),
	});

	if (result.success) {
		return { sent: true, logged };
	}

	return {
		sent: false,
		logged,
		error: result.error,
		errorCode: result.errorCode,
	};
}
