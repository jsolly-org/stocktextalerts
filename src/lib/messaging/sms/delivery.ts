import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { NO_TRACKED_ASSETS_MESSAGE } from "../asset-formatting";
import { buildMarketClosedBannerText } from "../market-closure-banner";
import { recordNotification } from "../shared";
import type { ProcessingStats, SmsUser } from "../types";
import { formatExtrasSection } from "./formatting";
import { sendUserSms } from "./index";
import type { SmsSender } from "./twilio-utils";

export type SmsExtras = {
	news?: string | null;
	rumors?: string | null;
	analyst?: string | null;
	insider?: string | null;
	citations?: string[];
};

/** Format the optional “extras” block appended to some SMS messages. */
function formatSmsExtras(extras?: SmsExtras): string {
	if (!extras) {
		return "";
	}

	const sections = [
		formatExtrasSection("🗞️ News", extras.news),
		formatExtrasSection("🤫 Rumors", extras.rumors),
		formatExtrasSection("📊 Analyst Consensus", extras.analyst),
		formatExtrasSection("🏦 Insider Trades", extras.insider),
	].filter(Boolean);

	return sections.join("\n\n");
}

/** Format the SMS body for a scheduled asset update. */
export function formatSmsMessage(
	assetsList: string,
	marketOpen: boolean,
	extras?: SmsExtras,
	marketClosureInfo?: MarketClosureInfo | null,
): string {
	const optOutSuffix = "Reply STOP to opt out.";
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	const header = "StockTextAlerts — Your scheduled price notification 📈";

	if (assetsList.trim() === NO_TRACKED_ASSETS_MESSAGE) {
		return `${header}\n\n${NO_TRACKED_ASSETS_MESSAGE}.\n\nManage your settings: ${dashboardUrl}\n\n${optOutSuffix}`;
	}

	const marketDisclaimer = marketOpen
		? ""
		: buildMarketClosedBannerText(marketClosureInfo ?? null);
	const extrasBlock = formatSmsExtras(extras);

	const sections = [
		header,
		assetsList,
		extrasBlock,
		marketDisclaimer,
		`Manage your settings: ${dashboardUrl}`,
		optOutSuffix,
	].filter(Boolean);

	return sections.join("\n\n");
}

/** Send and record an SMS scheduled update for a user. */
export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	assetsList: string,
	sendSms: SmsSender,
	marketOpen: boolean,
	extras?: SmsExtras,
	marketClosureInfo?: MarketClosureInfo | null,
): Promise<ProcessingStats> {
	const smsMessage = formatSmsMessage(
		assetsList,
		marketOpen,
		extras,
		marketClosureInfo,
	);

	const result = await sendUserSms(user, smsMessage, sendSms);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "market",
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
