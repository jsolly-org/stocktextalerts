import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { MarketClosureInfo } from "../../time/types";
import type { ActiveMarketSession, AssetPriceMap, MarketSession, UserAssetRow } from "../../types";
import { NO_SESSION_TRADE } from "../../types";
import { formatAssetsHtmlList } from "../email/asset-price-list";
import { buildEmailUrls, renderEmailFooter } from "../email/layout";
import { formatAssetsTextList } from "../parts/asset-price-list";
import { buildDataRecencyHtml, buildDataRecencyText } from "../parts/data-recency";
import { TELEGRAM_FOOTER } from "../parts/footer";
import {
	buildMarketClosedBannerEmailHtml,
	buildMarketClosedBannerEmailText,
	buildMarketClosedBannerTelegram,
} from "../parts/market-closure";
import {
	buildSessionFirstLineEmailHtml,
	buildSessionFirstLineEmailText,
	buildSessionFirstLineTelegram,
} from "../parts/session-label";
import { appendTelegramAssetPriceLines } from "../telegram/asset-price-lines";
import type { EmailFormatContext, EmailUser } from "../types";

/** Build the plaintext + HTML email body for a scheduled asset update. */
export function formatMarketScheduledEmail(
	user: EmailUser,
	userAssets: UserAssetRow[],
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
	const textFooter = `\n\nManage your delivery schedule: ${urls.scheduleUrl}\nUnsubscribe from all emails: ${urls.unsubscribeUrl}`;
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
	const dataRecencyText = buildDataRecencyText();
	const marketDisclaimer = marketOpen
		? ""
		: `\n${buildMarketClosedBannerEmailText(marketClosureInfo ?? null)}\n`;
	const sessionFirstLineText =
		sessionFirstLine && marketOpen
			? `${buildSessionFirstLineEmailText(
					marketSession,
					sessionFirstLine.scheduledEtMinutes,
					sessionFirstLine.is24,
				)}\n\n`
			: "";
	const sessionFirstLineHtml =
		sessionFirstLine && marketOpen
			? buildSessionFirstLineEmailHtml(
					marketSession,
					sessionFirstLine.scheduledEtMinutes,
					sessionFirstLine.is24,
				)
			: "";

	// Each channel renders its own asset list from raw data (userAssets + priceMap);
	// the pipeline no longer pre-renders one shared string. `formatAssetsTextList` is a
	// shared plaintext helper the email text part calls itself.
	const getPrice = (symbol: string) =>
		noSessionTrade?.has(symbol) ? NO_SESSION_TRADE : (priceMap.get(symbol) ?? undefined);
	const assetsList = formatAssetsTextList(
		userAssets,
		getPrice,
		getSparkline,
		true,
		marketOpen ? marketSession : undefined,
	);
	const text = `${sessionFirstLineText}Your tracked assets:\n${delayText}${dataRecencyText}\n${marketDisclaimer}${assetsList}${textFooter}`;
	const escapedAssetsListHtml = formatAssetsHtmlList(userAssets, getPrice, {
		getSparkline,
		getLogoHtml,
		showChangePercent: marketSession !== "closed",
		marketSession: marketOpen ? marketSession : undefined,
	});
	const marketClosedBannerHtml = marketOpen
		? ""
		: buildMarketClosedBannerEmailHtml(marketClosureInfo ?? null);
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
		${buildDataRecencyHtml()}
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

interface MarketScheduledTelegramOptions {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	/** Active session for this scheduled slot (Telegram is only sent for active sessions). */
	marketSession: ActiveMarketSession;
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	};
	delayBanner?: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	noSessionTrade?: Set<string>;
}

/** Render a scheduled multi-asset price snapshot as a Telegram message. The Telegram
 *  channel renders its own session label and market-closed banner from raw data. */
export function formatMarketScheduledTelegram(
	opts: MarketScheduledTelegramOptions,
): FormattedString {
	const sessionLabel = opts.sessionFirstLine
		? buildSessionFirstLineTelegram(
				opts.marketSession,
				opts.sessionFirstLine.scheduledEtMinutes,
				opts.sessionFirstLine.is24,
			)
		: null;
	const marketClosedBanner = opts.marketClosureInfo
		? buildMarketClosedBannerTelegram(opts.marketClosureInfo)
		: null;
	const header = sessionLabel ? `📈 Price Update · ${sessionLabel}` : "📈 Price Update";
	let msg = fmt`${FormattedString.bold(header)}`;
	if (opts.delayBanner) {
		msg = fmt`${msg}\n${opts.delayBanner}`;
	}
	msg = fmt`${msg}\n${buildDataRecencyText()}`;
	if (marketClosedBanner) {
		msg = fmt`${msg}\n${marketClosedBanner}`;
	}

	msg = appendTelegramAssetPriceLines({
		msg,
		userAssets: opts.userAssets,
		assetPrices: opts.assetPrices,
		noSessionTrade: opts.noSessionTrade,
		marketSession: opts.marketSession,
	});

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;
	return msg;
}
