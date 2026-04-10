import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import type { MarketClosureInfo } from "../../time/market-calendar";
import { NO_TRACKED_ASSETS_MESSAGE } from "../asset-formatting";
import { buildMarketClosedBannerText } from "../market-closure-banner";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { ProcessingStats, SmsUser } from "../types";
import { formatExtrasSection } from "./formatting";
import { sendUserSms } from "./index";
import { padUrlsToSegmentBoundaries } from "./segment-utils";
import type { SmsSender } from "./twilio-utils";
import { shortenUrl } from "./url-shortener";

export type SmsExtras = {
	news?: string | null;
	rumors?: string | null;
	analyst?: string | null;
	insider?: string | null;
	topMovers?: string | null;
	citations?: string[];
};

/** Format the optional “extras” block appended to some SMS messages.
 * `topMovers` is intentionally not rendered here — it's an email-only section. */
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

/** Format the SMS body for a scheduled asset update.
 * Pass `dashboardUrl` when calling in a batch to avoid per-message DB shortening. */
export async function formatSmsMessage(
	assetsList: string,
	marketOpen: boolean,
	extras?: SmsExtras,
	marketClosureInfo?: MarketClosureInfo | null,
	supabase?: AppSupabaseClient,
	/** Pre-shortened dashboard URL; when set, skips per-message shortenUrl. */
	dashboardUrl?: string,
	/** Optional delay banner text (inserted after header when notification is late). */
	delayBanner?: string | null,
): Promise<string> {
	const optOutSuffix = "Reply STOP to opt out.";
	const resolvedDashboardUrl =
		dashboardUrl ??
		(supabase
			? await shortenUrl(
					new URL("/dashboard", getSiteUrl()).toString(),
					supabase,
				)
			: new URL("/dashboard", getSiteUrl()).toString());

	const header = "StockTextAlerts — Your scheduled price notification 📈";

	if (assetsList.trim() === NO_TRACKED_ASSETS_MESSAGE) {
		return padUrlsToSegmentBoundaries(
			`${header}\n\n${NO_TRACKED_ASSETS_MESSAGE}.\n\nManage your settings: ${resolvedDashboardUrl}\n\n${optOutSuffix}`,
		);
	}

	const marketDisclaimer = marketOpen
		? ""
		: buildMarketClosedBannerText(marketClosureInfo ?? null);
	const extrasBlock = formatSmsExtras(extras);

	const sections = [
		header,
		delayBanner || "",
		marketDisclaimer,
		assetsList,
		extrasBlock,
		`Manage your settings: ${resolvedDashboardUrl}`,
		optOutSuffix,
	].filter(Boolean);

	return padUrlsToSegmentBoundaries(sections.join("\n\n"));
}

/** Send and record an SMS scheduled update for a user.
 * Pass `dashboardUrl` when processing a batch to avoid per-message DB shortening. */
export async function processSmsUpdate(
	supabase: AppSupabaseClient,
	user: SmsUser,
	assetsList: string,
	sendSms: SmsSender,
	marketOpen: boolean,
	extras?: SmsExtras,
	marketClosureInfo?: MarketClosureInfo | null,
	/** Pre-shortened dashboard URL; when set, skips per-message shortenUrl. */
	dashboardUrl?: string,
	/** Optional delay banner text for late notifications. */
	delayBanner?: string | null,
): Promise<ProcessingStats> {
	const smsMessage = await formatSmsMessage(
		assetsList,
		marketOpen,
		extras,
		marketClosureInfo,
		supabase,
		dashboardUrl,
		delayBanner,
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

	return {
		sent: result.success,
		logged,
		error: result.success ? undefined : result.error,
		errorCode: result.success ? undefined : result.errorCode,
	};
}
