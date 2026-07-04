import type { AppSupabaseClient } from "../../db/supabase";
import type { MarketClosureInfo } from "../../time/types";
import type { AssetPriceMap, MarketSession, ProcessingStats, UserAssetRow } from "../../types";
import { formatMarketScheduledSms } from "../notifications/market-scheduled";
import type { SparklineData } from "../parts/charts/sparkline";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { NotificationExtras, SmsSender, SmsUser } from "../types";
import { sendUserSms } from "./index";

/** Send and record an SMS scheduled update for a user. */
export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	userAssets: UserAssetRow[],
	priceMap: AssetPriceMap,
	sendSms: SmsSender,
	marketSession: MarketSession,
	extras?: NotificationExtras,
	marketClosureInfo?: MarketClosureInfo | null,
	delayBanner?: string | null,
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	},
	noSessionTrade?: Set<string>,
	getSparkline?: (symbol: string) => SparklineData | null | undefined,
): Promise<ProcessingStats> {
	const smsMessage = formatMarketScheduledSms({
		userAssets,
		priceMap,
		marketSession,
		noSessionTrade,
		getSparkline,
		extras,
		marketClosureInfo,
		delayBanner,
		sessionFirstLine,
	});

	const result = await sendUserSms(user, smsMessage, sendSms, supabase);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "market",
		delivery_method: "sms",
		message_delivered: result.success,
		message: smsMessage,
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
