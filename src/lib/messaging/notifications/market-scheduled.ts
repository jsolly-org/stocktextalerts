import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { getSiteUrl } from "../../db/env";
import type { AssetPriceMap, MarketSession } from "../../market-data-types";
import { NO_SESSION_TRADE } from "../../market-data-types";
import type { MarketClosureInfo } from "../../time/market/calendar";
import type { UserAssetRow } from "../../user-record-types";
import { buildEmailUrls, renderEmailFooter } from "../email/layout";
import {
	appendTelegramAssetPriceLines,
	formatAssetsHtmlList,
	NO_TRACKED_ASSETS_MESSAGE,
} from "../parts/asset-price-list";
import { formatContentSection } from "../parts/content-section";
import type { NotificationExtras } from "../parts/extras";
import { NOT_FINANCIAL_ADVICE, SMS_OPT_OUT, TELEGRAM_FOOTER } from "../parts/footer";
import { buildMarketClosedBannerHtml, buildMarketClosedBannerText } from "../parts/market-closure";
import { buildSessionFirstLine, buildSessionFirstLineHtml } from "../parts/session-label";
import { padUrlsToSegmentBoundaries } from "../sms/segment-utils";
import type { EmailFormatContext, EmailUser } from "../types";

/** Format the optional "extras" block appended to scheduled market SMS messages. */
function formatScheduledMarketSmsExtras(extras?: NotificationExtras): string {
	if (!extras) {
		return "";
	}

	const sections = [
		formatContentSection("🗞️ News", extras.news),
		formatContentSection("🤫 Rumors", extras.rumors),
		formatContentSection("📊 Analyst Consensus", extras.analyst),
		formatContentSection("🏦 Insider Trades", extras.insider),
	].filter(Boolean);

	return sections.join("\n\n");
}

/** Build the plaintext + HTML email body for a scheduled asset update. */
export function formatMarketScheduledEmail(
	user: EmailUser,
	userAssets: UserAssetRow[],
	assetsList: string,
	priceMap: AssetPriceMap,
	marketSession: MarketSession,
	context?: EmailFormatContext,
	delayBanners?: {
		text?: string | null;
		html?: string | null;
	},
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	},
	noSessionTrade?: Set<string>,
): { text: string; html: string } {
	const { getSparkline, marketClosureInfo, getLogoHtml } = context ?? {};
	const marketOpen = marketSession !== "closed";
	const urls = buildEmailUrls(user.id, user.email, "marketNotifications");
	const textFooter = `\n\nManage your delivery schedule: ${urls.scheduleUrl}\nUnsubscribe from all emails: ${urls.unsubscribeUrl}\n${NOT_FINANCIAL_ADVICE}`;
	const htmlFooter = renderEmailFooter(urls);

	if (userAssets.length === 0) {
		const text = `You don't have any tracked assets yet.\n\nVisit your dashboard to add assets to track: ${urls.dashboardUrl}${textFooter}`;
		const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Scheduled Price Update</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Get Started Tracking Assets</h2>
		<p style="color: #4b5563; font-size: 16px; margin-bottom: 30px;">
			You don't have any tracked assets yet. Start tracking your favorite assets to receive regular updates!
		</p>
		<div style="text-align: center; margin: 40px 0;">
			<a href="${urls.escapedDashboardUrl}" style="display: inline-block; background: #667eea; color: white; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 16px; transition: background 0.2s;">
				Add Assets to Track →
			</a>
		</div>
		<p style="color: #6b7280; font-size: 14px; margin-top: 30px; padding-top: 30px; border-top: 1px solid #e5e7eb;">
			Once you add assets to your dashboard, you'll receive regular updates about them during your configured notification window.
		</p>
		${htmlFooter}
	</div>
</body>
</html>`;
		return { text, html };
	}

	const delayText = delayBanners?.text ? `\n${delayBanners.text}\n` : "";
	const marketDisclaimer = marketOpen
		? ""
		: `\n${buildMarketClosedBannerText(marketClosureInfo ?? null)}\n`;
	const sessionFirstLineText =
		sessionFirstLine && marketOpen
			? `${buildSessionFirstLine(
					marketSession,
					sessionFirstLine.scheduledEtMinutes,
					sessionFirstLine.is24,
				)}\n\n`
			: "";
	const sessionFirstLineHtml =
		sessionFirstLine && marketOpen
			? buildSessionFirstLineHtml(
					marketSession,
					sessionFirstLine.scheduledEtMinutes,
					sessionFirstLine.is24,
				)
			: "";

	const text = `${sessionFirstLineText}Your tracked assets:\n${delayText}${marketDisclaimer}${assetsList}${textFooter}`;
	const getPriceForHtml = (symbol: string) =>
		noSessionTrade?.has(symbol) ? NO_SESSION_TRADE : (priceMap.get(symbol) ?? undefined);
	const escapedAssetsListHtml = formatAssetsHtmlList(userAssets, getPriceForHtml, {
		getSparkline,
		getLogoHtml,
		showChangePercent: marketSession !== "closed",
		marketSession: marketOpen ? marketSession : undefined,
	});
	const marketClosedBannerHtml = marketOpen
		? ""
		: buildMarketClosedBannerHtml(marketClosureInfo ?? null);
	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Scheduled Price Update</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${sessionFirstLineHtml}
		${delayBanners?.html || ""}
		${marketClosedBannerHtml}
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Your Scheduled Price Notification</h2>
		<div style="background: #f9fafb; padding: 20px; border-radius: 6px; margin-bottom: 30px; color: #1f2937; font-size: 14px;">
			${escapedAssetsListHtml}
		</div>
		<div style="text-align: center; margin-top: 30px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your notifications →
			</a>
		</div>
		${htmlFooter}
	</div>
</body>
</html>`;

	return { text, html };
}

/** Format the SMS body for a scheduled asset update. */
export function formatMarketScheduledSms(
	assetsList: string,
	marketSession: MarketSession,
	extras?: NotificationExtras,
	marketClosureInfo?: MarketClosureInfo | null,
	delayBanner?: string | null,
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
	const extrasBlock = formatScheduledMarketSmsExtras(extras);
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

interface MarketScheduledTelegramOptions {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	sessionLabel?: string | null;
	delayBanner?: string | null;
	marketClosedBanner?: string | null;
}

/** Render a scheduled multi-asset price snapshot as a Telegram message. */
export function formatMarketScheduledTelegram(
	opts: MarketScheduledTelegramOptions,
): FormattedString {
	const header = opts.sessionLabel ? `📈 Price Update · ${opts.sessionLabel}` : "📈 Price Update";
	let msg = fmt`${FormattedString.bold(header)}`;
	if (opts.delayBanner) {
		msg = fmt`${msg}\n${opts.delayBanner}`;
	}
	if (opts.marketClosedBanner) {
		msg = fmt`${msg}\n${opts.marketClosedBanner}`;
	}

	msg = appendTelegramAssetPriceLines({
		msg,
		userAssets: opts.userAssets,
		assetPrices: opts.assetPrices,
	});

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;
	return msg;
}
