import type { AppSupabaseClient } from "../../db/supabase";
import { recordNotification } from "../shared";
import { NO_TRACKED_STOCKS_MESSAGE } from "../stock-formatting";
import type { ProcessingStats, SmsUser } from "../types";
import { formatExtrasSection } from "./formatting";
import { sendUserSms } from "./index";
import type { SmsSender } from "./twilio-utils";

export type SmsExtras = {
	news?: string | null;
	rumors?: string | null;
};

function formatSmsExtras(extras?: SmsExtras): string {
	if (!extras) {
		return "";
	}

	const sections = [
		formatExtrasSection("🗞️ News", extras.news),
		formatExtrasSection("🤫 Rumors", extras.rumors),
	].filter(Boolean);

	return sections.join("\n\n");
}

export function formatSmsMessage(
	stocksList: string,
	marketOpen: boolean,
	extras?: SmsExtras,
): string {
	const optOutSuffix = "Reply STOP to opt out.";

	if (stocksList.trim() === NO_TRACKED_STOCKS_MESSAGE) {
		return `${NO_TRACKED_STOCKS_MESSAGE}. ${optOutSuffix}`;
	}

	const marketDisclaimer = marketOpen ? "" : "Prices as of last market close.";
	const extrasBlock = formatSmsExtras(extras);

	const sections = [
		stocksList,
		extrasBlock,
		marketDisclaimer,
		optOutSuffix,
	].filter(Boolean);

	return sections.join("\n\n");
}

export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	stocksList: string,
	sendSms: SmsSender,
	marketOpen: boolean,
	extras?: SmsExtras,
): Promise<ProcessingStats> {
	const smsMessage = formatSmsMessage(stocksList, marketOpen, extras);

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
