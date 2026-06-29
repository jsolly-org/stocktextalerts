import type { AppSupabaseClient } from "../../db/supabase";
import type { ProcessingStats } from "../../delivery-types";
import type { MarketSession } from "../../market-data-types";
import type { MarketClosureInfo } from "../../time/market/calendar";
import { formatMarketScheduledSms } from "../notifications/market-scheduled";
import type { NotificationExtras } from "../parts/extras";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { SmsUser } from "../types";
import { sendUserSms } from "./index";
import type { SmsSender } from "./twilio-utils";

/** Send and record an SMS scheduled update for a user. */
export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	assetsList: string,
	sendSms: SmsSender,
	marketSession: MarketSession,
	extras?: NotificationExtras,
	marketClosureInfo?: MarketClosureInfo | null,
	delayBanner?: string | null,
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	},
): Promise<ProcessingStats> {
	const smsMessage = formatMarketScheduledSms(
		assetsList,
		marketSession,
		extras,
		marketClosureInfo,
		delayBanner,
		sessionFirstLine,
	);

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
