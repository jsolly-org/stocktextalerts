import type { AppSupabaseClient } from "../../db/supabase";
import { recordNotification } from "../shared";
import type { ProcessingStats, SmsUser } from "../types";
import { sendUserSms } from "./index";
import type { SmsSender } from "./twilio-utils";

export type SmsExtras = {
	news?: string | null;
	rumors?: string | null;
};

function formatExtrasSection(title: string, content: string): string {
	const normalized = content.trim();
	if (!normalized) {
		return "";
	}
	return `${title}\n${normalized}`;
}

function formatSmsExtras(extras?: SmsExtras): string {
	if (!extras) {
		return "";
	}

	const sections = [
		formatExtrasSection("🗞️ News", extras.news ?? ""),
		formatExtrasSection("🤫 Rumors", extras.rumors ?? ""),
	].filter(Boolean);

	return sections.join("\n\n");
}

export function formatSmsMessage(
	stocksList: string,
	marketOpen: boolean,
	extras?: SmsExtras,
): string {
	const optOutSuffix = "Reply STOP to opt out.";

	if (stocksList.trim() === "You don't have any tracked stocks") {
		return `You don't have any tracked stocks. ${optOutSuffix}`;
	}

	const marketDisclaimer = marketOpen ? "" : "Prices as of last market close.";
	const extrasBlock = formatSmsExtras(extras);

	const sections = [
		stocksList,
		extrasBlock,
		marketDisclaimer,
		optOutSuffix,
	].filter((section) => Boolean(section));

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
