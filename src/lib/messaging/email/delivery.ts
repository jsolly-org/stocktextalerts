import type { AppSupabaseClient } from "../../db/supabase";
import type { AssetPriceMap } from "../../providers/price-fetcher";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { SparklineData } from "../sparkline";
import type {
	EmailUser,
	FormatPreferences,
	ProcessingStats,
	UserAssetRow,
} from "../types";
import { sendUserEmail } from "./index";
import { type EmailSender, formatEmailMessage } from "./utils";

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
	marketOpen: boolean,
	formatPrefs?: FormatPreferences,
	getSparkline?: (symbol: string) => SparklineData | null | undefined,
	marketClosureInfo?: MarketClosureInfo | null,
): Promise<ProcessingStats> {
	const message = formatEmailMessage(
		user,
		userAssets,
		assetsList,
		priceMap,
		marketOpen,
		formatPrefs,
		getSparkline,
		marketClosureInfo,
	);
	const result = await sendUserEmail(
		user,
		"Your Scheduled Price Notification",
		message,
		sendEmail,
	);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "market",
		delivery_method: "email",
		message_delivered: result.success,
		message: message.text,
		...deliveryResultToLogFields(result),
	});

	return {
		sent: result.success,
		logged,
		error: result.success ? undefined : result.error,
		errorCode: result.success ? undefined : result.errorCode,
	};
}
