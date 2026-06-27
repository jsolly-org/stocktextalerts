import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import { buildSessionFirstLine } from "../../market-notifications/scheduled/session-label";
import type { MarketClosureInfo } from "../../time/market-calendar";
import type { MarketSession } from "../../vendors/price-fetcher";
import { NO_TRACKED_ASSETS_MESSAGE } from "../asset-formatting";
import { NOT_FINANCIAL_ADVICE, SMS_OPT_OUT } from "../footer";
import { buildMarketClosedBannerText } from "../market-closure-banner";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { ProcessingStats, SmsUser } from "../types";
import { formatExtrasSection } from "./formatting";
import { sendUserSms } from "./index";
import { padUrlsToSegmentBoundaries } from "./segment-utils";
import type { SmsSender } from "./twilio-utils";

export type SmsExtras = {
	news?: string | null;
	rumors?: string | null;
	analyst?: string | null;
	insider?: string | null;
	topMovers?: string | null;
	citations?: string[];
};

/** Format the optional “extras” block appended to scheduled market SMS messages.
 * Daily digest SMS renders `topMovers` via `formatDailyDigestSmsMessage` instead. */
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
	marketSession: MarketSession,
	extras?: SmsExtras,
	marketClosureInfo?: MarketClosureInfo | null,
	/** Optional delay banner text (inserted after header when notification is late). */
	delayBanner?: string | null,
	/** Session-aware first body line metadata (pre/regular/after/closed). */
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	},
): string {
	const optOutSuffix = SMS_OPT_OUT;
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const marketOpen = marketSession !== "closed";

	const header = "StockTextAlerts — Your scheduled price notification 📈";

	if (assetsList.trim() === NO_TRACKED_ASSETS_MESSAGE) {
		return padUrlsToSegmentBoundaries(
			`${header}\n\n${NO_TRACKED_ASSETS_MESSAGE}.\n\nManage your notifications: ${dashboardUrl}\n\n${optOutSuffix}\n\n${NOT_FINANCIAL_ADVICE}`,
		);
	}

	const marketDisclaimer = marketOpen ? "" : buildMarketClosedBannerText(marketClosureInfo ?? null);
	const extrasBlock = formatSmsExtras(extras);
	// Session-first-line is only rendered for active sessions. `marketOpen`
	// narrows `marketSession` to ActiveMarketSession (excludes "closed").
	const sessionFirstLineText =
		sessionFirstLine && marketOpen
			? buildSessionFirstLine(
					marketSession,
					sessionFirstLine.scheduledEtMinutes,
					sessionFirstLine.is24,
				)
			: "";

	const sections = [
		header,
		sessionFirstLineText,
		delayBanner || "",
		marketDisclaimer,
		assetsList,
		extrasBlock,
		`Manage your notifications: ${dashboardUrl}`,
		optOutSuffix,
		NOT_FINANCIAL_ADVICE,
	].filter(Boolean);

	return padUrlsToSegmentBoundaries(sections.join("\n\n"));
}

/** Send and record an SMS scheduled update for a user. */
export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	assetsList: string,
	sendSms: SmsSender,
	marketSession: MarketSession,
	extras?: SmsExtras,
	marketClosureInfo?: MarketClosureInfo | null,
	/** Optional delay banner text for late notifications. */
	delayBanner?: string | null,
	/** Session-aware first body line metadata. */
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	},
): Promise<ProcessingStats> {
	const smsMessage = formatSmsMessage(
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
