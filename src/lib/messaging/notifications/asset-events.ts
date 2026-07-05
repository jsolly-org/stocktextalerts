import { FormattedString, fmt } from "@grammyjs/parse-mode";
import { getSiteUrl } from "../../db/env";
import type { MarketClosureInfo } from "../../time/types";
import { renderEmailSection } from "../email/html-section";
import { buildEmailUrls, renderEmailFooter } from "../email/layout";
import { SMS_OPT_OUT, TELEGRAM_FOOTER } from "../parts/footer";
import {
	buildMarketClosedBannerEmailHtml,
	buildMarketClosedBannerEmailText,
	buildMarketClosedBannerSms,
	buildMarketClosedBannerTelegram,
} from "../parts/market-closure";
import { padUrlsToSegmentBoundaries } from "../sms/segment-utils";

/** Build the SMS body for an asset-events digest. */
export function formatAssetEventsSms(options: {
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	delayBanner?: string | null;
}): string {
	const optOutSuffix = SMS_OPT_OUT;
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	const parts: string[] = ["StockTextAlerts — Asset Events 🗓️"];

	if (options.delayBanner) {
		parts.push(options.delayBanner);
	}

	if (options.marketClosureInfo) {
		parts.push(buildMarketClosedBannerSms(options.marketClosureInfo, "events"));
	}

	if (options.earningsSection) {
		parts.push(`📅 Earnings\n${options.earningsSection}`);
	}
	if (options.dividendsSection) {
		parts.push(`💰 Ex-Dividend\n${options.dividendsSection}`);
	}
	if (options.splitsSection) {
		parts.push(`✂️ Splits\n${options.splitsSection}`);
	}
	if (options.iposSection) {
		parts.push(`🆕 Upcoming IPOs\n${options.iposSection}`);
	}
	if (options.insiderSection) {
		parts.push(`🏦 Insider Trades\n${options.insiderSection}`);
	}
	if (options.analystSection) {
		parts.push(`📊 Analyst Consensus (published monthly on the 1st)\n${options.analystSection}`);
	}

	parts.push(`Manage your notifications: ${dashboardUrl}`);
	parts.push(optOutSuffix);

	return padUrlsToSegmentBoundaries(parts.join("\n\n"));
}

/** Build the email payload (subject/text/html) for an asset-events digest. */
export function formatAssetEventsEmail(options: {
	user: { id: string; email: string };
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
	delayBannerText?: string | null;
	delayBannerHtml?: string | null;
}): { subject: string; text: string; html: string } {
	const urls = buildEmailUrls(options.user.id, options.user.email, "assetEvents");

	const textParts: string[] = ["Asset Events"];

	if (options.delayBannerText) {
		textParts.push(options.delayBannerText);
	}

	if (options.marketClosureInfo) {
		textParts.push(buildMarketClosedBannerEmailText(options.marketClosureInfo, "events"));
	}

	if (options.earningsSection) {
		textParts.push(`\n📅 Earnings\n${options.earningsSection}`);
	}
	if (options.dividendsSection) {
		textParts.push(`\n💰 Ex-Dividend Dates\n${options.dividendsSection}`);
	}
	if (options.splitsSection) {
		textParts.push(`\n✂️ Stock Splits\n${options.splitsSection}`);
	}
	if (options.iposSection) {
		textParts.push(`\n🆕 Upcoming IPOs\n${options.iposSection}`);
	}
	if (options.insiderSection) {
		textParts.push(`\n🏦 Insider Trades\n${options.insiderSection}`);
	}
	if (options.analystSection) {
		textParts.push(
			`\n📊 Analyst Consensus (published monthly on the 1st)\n${options.analystSection}`,
		);
	}
	textParts.push(`\nManage your notifications: ${urls.dashboardUrl}`);
	textParts.push(`Manage your delivery schedule: ${urls.scheduleUrl}`);
	textParts.push(`Unsubscribe from all emails: ${urls.unsubscribeUrl}`);

	const subject = "Asset Events";
	const text = textParts.join("\n");

	const marketClosedHtml = options.marketClosureInfo
		? buildMarketClosedBannerEmailHtml(options.marketClosureInfo, "events")
		: "";

	let sectionsHtml = "";
	if (options.earningsSection) {
		sectionsHtml += renderEmailSection("📅", "Earnings", options.earningsSection, {
			showFinnhubLogo: true,
		});
	}
	if (options.dividendsSection) {
		sectionsHtml += renderEmailSection("💰", "Ex-Dividend Dates", options.dividendsSection, {
			showMassiveLogo: true,
		});
	}
	if (options.splitsSection) {
		sectionsHtml += renderEmailSection("✂️", "Stock Splits", options.splitsSection, {
			showMassiveLogo: true,
		});
	}
	if (options.iposSection) {
		sectionsHtml += renderEmailSection("🆕", "Upcoming IPOs", options.iposSection, {
			showMassiveLogo: true,
		});
	}
	if (options.insiderSection) {
		sectionsHtml += renderEmailSection("🏦", "Insider Trades", options.insiderSection, {
			showFinnhubLogo: true,
		});
	}
	if (options.analystSection) {
		sectionsHtml += renderEmailSection(
			"📊",
			"Analyst Consensus (published monthly on the 1st)",
			options.analystSection,
			{ showFinnhubLogo: true },
		);
	}
	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Asset Events</h1>
	</div>
	<div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${options.delayBannerHtml || ""}
		${marketClosedHtml}
		<h2 style="margin: 0 0 8px; font-size: 18px;">Asset Events</h2>
		<p style="margin: 0 0 16px; color: #6b7280; font-size: 14px;">Upcoming events for your tracked assets</p>
		${sectionsHtml}
		<div style="text-align: center; margin-top: 20px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your notifications →
			</a>
		</div>
		${renderEmailFooter(urls)}
	</div>
</body>
</html>`;

	return { subject, text, html };
}

/** Render a standalone asset-events digest as a Telegram message. */
export function formatAssetEventsTelegram(opts: {
	earningsSection: string | null;
	dividendsSection: string | null;
	splitsSection: string | null;
	iposSection: string | null;
	analystSection: string | null;
	insiderSection: string | null;
	delayBanner?: string | null;
	marketClosureInfo?: MarketClosureInfo | null;
}): FormattedString {
	let msg = fmt`${FormattedString.bold("🗓️ Asset Events")}`;

	if (opts.delayBanner) {
		msg = fmt`${msg}\n${opts.delayBanner}`;
	}
	if (opts.marketClosureInfo) {
		msg = fmt`${msg}\n${buildMarketClosedBannerTelegram(opts.marketClosureInfo, "events")}`;
	}

	if (opts.earningsSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📅 Earnings")}\n${opts.earningsSection}`;
	}
	if (opts.dividendsSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("💰 Ex-Dividend")}\n${opts.dividendsSection}`;
	}
	if (opts.splitsSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("✂️ Splits")}\n${opts.splitsSection}`;
	}
	if (opts.iposSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🆕 Upcoming IPOs")}\n${opts.iposSection}`;
	}
	if (opts.insiderSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🏦 Insider Trades")}\n${opts.insiderSection}`;
	}
	if (opts.analystSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📊 Analyst Consensus (published monthly on the 1st)")}\n${opts.analystSection}`;
	}

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;
	return msg;
}
