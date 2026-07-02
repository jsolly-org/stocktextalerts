import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { buildAssetEventsContent } from "../../asset-events/content";
import { US_MARKET_TIMEZONE } from "../../constants";
import { getSiteUrl } from "../../db/env";
import type { MarketClosureInfo } from "../../time/types";
import type { AssetPriceMap, DeliveryResult, UserAssetRow } from "../../types";
import { renderEmailSection } from "../email/html-section";
import { buildEmailUrls, renderEmailFooter } from "../email/layout";
import {
	appendTelegramAssetPriceLines,
	formatAssetsHtmlList,
	formatAssetTextLine,
} from "../parts/asset-price-list";
import type { SparklineData, SparklineMap } from "../parts/charts/sparkline";
import { formatContentSection } from "../parts/content-section";
import type { NotificationExtras } from "../parts/extras";
import { NOT_FINANCIAL_ADVICE, SMS_OPT_OUT, TELEGRAM_FOOTER } from "../parts/footer";
import {
	buildMarketClosedBannerHtml,
	buildMarketClosedBannerText,
	buildMarketClosureLabel,
} from "../parts/market-closure";
import { packSmsBlocks, type SmsBlock } from "../sms/block-packing";
import { padDailyDigestSmsSegmentBoundaries } from "../sms/segment-utils";

const TICKER_LINE_RE = /^[A-Z][A-Z0-9.-]{0,9}:\s/;
const QUOTE_TIMESTAMP_FORMAT_BASE: Intl.DateTimeFormatOptions = {
	timeZone: US_MARKET_TIMEZONE,
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
};
const QUOTE_TIMESTAMP_FORMATTER_12H = new Intl.DateTimeFormat("en-US", {
	...QUOTE_TIMESTAMP_FORMAT_BASE,
	hour12: true,
});
const QUOTE_TIMESTAMP_FORMATTER_24H = new Intl.DateTimeFormat("en-US", {
	...QUOTE_TIMESTAMP_FORMAT_BASE,
	hour12: false,
});

/** The latest quote timestamp in the map, formatted in ET as an "as of" label
 *  ("Jan 2, 2025, 4:00 PM EST" / "Jan 2, 2025, 16:00 EST"), or null when none is usable.
 *  Stamps the market-closed banner with how stale the last-close prices are — shared by all
 *  three digest channels. Respects `use_24_hour_time` per the UI time convention (`is24`). */
export function formatDigestQuoteAsOf(assetPrices: AssetPriceMap, is24: boolean): string | null {
	let latest: number | null = null;
	for (const quote of assetPrices.values()) {
		if (!quote || typeof quote.timestamp !== "number") continue;
		if (!Number.isFinite(quote.timestamp) || quote.timestamp <= 0) continue;
		latest = latest === null ? quote.timestamp : Math.max(latest, quote.timestamp);
	}
	if (!latest) return null;
	const formatter = is24 ? QUOTE_TIMESTAMP_FORMATTER_24H : QUOTE_TIMESTAMP_FORMATTER_12H;
	return formatter.format(new Date(latest * 1000));
}

/**
 * Ensure each ticker snippet starts after a blank line so entries are visually separated.
 * Only applied to email digest extras where source formatting can be inconsistent.
 */
function ensureBlankLineBetweenTickerSnippets(content: string): string {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const normalized: string[] = [];

	for (const line of lines) {
		const isTickerLine = TICKER_LINE_RE.test(line);
		const prev = normalized.at(-1);

		if (isTickerLine && normalized.length > 0 && prev !== "") {
			normalized.push("");
		}

		if (line === "" && prev === "") {
			continue;
		}

		normalized.push(line);
	}

	return normalized.join("\n").trim();
}

type AssetEventsResult = Awaited<ReturnType<typeof buildAssetEventsContent>> | null;

type DailyDigestSmsFormatOptions = {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: NotificationExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
	marketClosureInfo?: MarketClosureInfo | null;
	/** User's 24-hour-time preference for the market-closed "as of" timestamp.
	 *  Defaults to 12-hour (the DB default) when omitted; production callers pass it. */
	is24Hour?: boolean;
	/** Optional delay banner text (inserted after header when notification is late). */
	delayBanner?: string | null;
};

/** Show change % on closed-market digests only when a 7-day sparkline anchors it. */
function shouldShowDigestChangePercent(
	marketOpen: boolean | undefined,
	sparkline?: SparklineData | null,
): boolean {
	if (marketOpen !== false) return true;
	return sparkline?.window === "7-trading-days" && sparkline.values.length >= 2;
}

/** Format the daily digest message body for SMS delivery. */
export function formatDailyDigestSmsMessage(options: DailyDigestSmsFormatOptions): string {
	return formatDailyDigestSmsMessages(options).join("\n\n");
}

/** Format packed daily digest SMS bodies before segment-boundary padding. */
export function formatDailyDigestSmsMessageBodies(options: DailyDigestSmsFormatOptions): string[] {
	return packSmsBlocks(buildDailyDigestSmsBlocks(options));
}

/** Format the daily digest SMS payload as one or more boundary-aware bodies. */
export function formatDailyDigestSmsMessages(options: DailyDigestSmsFormatOptions): string[] {
	return formatDailyDigestSmsMessageBodies(options).map((message) =>
		padDailyDigestSmsSegmentBoundaries(message),
	);
}

/** Format one notification_log message for a single-part or multipart SMS attempt. */
export function formatDailyDigestSmsLogMessage(messages: string[]): string {
	if (messages.length === 1) {
		return messages[0] ?? "";
	}

	return messages
		.map((message, index) => `--- SMS part ${index + 1}/${messages.length} ---\n${message}`)
		.join("\n\n");
}

/** Collapse per-part SMS delivery results into one attempt-level result. */
export function summarizeDailyDigestSmsResults(
	results: DeliveryResult[],
	totalParts: number,
): DeliveryResult {
	if (totalParts === 0) {
		return { success: false, error: "No SMS parts to send" };
	}

	if (results.length === totalParts && results.every((result) => result.success)) {
		return { success: true };
	}

	const failedIndex = results.findIndex((result) => !result.success);
	const failed = failedIndex >= 0 ? results[failedIndex] : null;
	const failedPartNumber = failedIndex >= 0 ? failedIndex + 1 : results.length + 1;
	const error = failed?.success === false ? failed.error : "Unknown error";
	const errorCode = failed?.success === false ? failed.errorCode : undefined;

	return {
		success: false,
		error: `SMS part ${failedPartNumber}/${totalParts} failed: ${error}`,
		...(errorCode !== undefined ? { errorCode } : {}),
	};
}

/** Build the daily digest SMS as ordered blocks for body packing. */
function buildDailyDigestSmsBlocks(options: DailyDigestSmsFormatOptions): SmsBlock[] {
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const marketDisclaimer =
		options.marketOpen === false
			? buildMarketClosedBannerText(
					options.marketClosureInfo,
					"prices",
					formatDigestQuoteAsOf(options.assetPrices, options.is24Hour ?? false),
				)
			: "";
	const ae = options.assetEvents;

	return [
		{ id: "header", boundary: "atomic", text: "StockTextAlerts — Your daily digest 🗓️" },
		{ id: "delayBanner", boundary: "atomic", text: options.delayBanner },
		{ id: "marketDisclaimer", boundary: "atomic", text: marketDisclaimer },
		{
			id: "assets",
			boundary: "split-between-children",
			header: "💰 Your Assets",
			children: buildDailyDigestPriceLines(options),
			childSeparator: "\n\n",
		},
		{
			id: "topMovers",
			boundary: "atomic",
			text: formatContentSection("🚀 Top Movers", options.extras.topMovers),
		},
		{ id: "news", boundary: "atomic", text: formatContentSection("🗞️ News", options.extras.news) },
		{
			id: "rumors",
			boundary: "atomic",
			text: formatContentSection("🤫 Rumors", options.extras.rumors),
		},
		{
			id: "earnings",
			boundary: "atomic",
			text: formatContentSection("📈 Earnings", ae?.eventsSection?.earnings),
		},
		{
			id: "dividends",
			boundary: "atomic",
			text: formatContentSection("💰 Dividends", ae?.eventsSection?.dividends),
		},
		{
			id: "splits",
			boundary: "atomic",
			text: formatContentSection("✂️ Splits", ae?.eventsSection?.splits),
		},
		{
			id: "ipos",
			boundary: "atomic",
			text: formatContentSection("🆕 Upcoming IPOs", ae?.eventsSection?.ipos),
		},
		{
			id: "analystConsensus",
			boundary: "atomic",
			text: formatContentSection("📊 Analyst Consensus", ae?.analystSection),
		},
		{
			id: "insiderTrades",
			boundary: "atomic",
			text: formatContentSection("🏦 Insider Trades", ae?.insiderSection),
		},
		{
			id: "footer",
			boundary: "atomic",
			text: `Manage your notifications:\n${dashboardUrl}\n\n${SMS_OPT_OUT}\n\n${NOT_FINANCIAL_ADVICE}`,
		},
	];
}

/** Format a single asset price line for the SMS/plain-text digest. */
function formatDailyDigestPriceLine(
	asset: UserAssetRow,
	quote: { price: number; changePercent: number } | null | undefined,
	sparkline?: SparklineData | null,
	showChangePercent = true,
): string {
	return formatAssetTextLine(asset, quote ?? undefined, sparkline, showChangePercent);
}

/** Build per-asset SMS price lines so the asset block can split between entries. */
function buildDailyDigestPriceLines(options: DailyDigestSmsFormatOptions): string[] {
	return options.userAssets.map((asset) => {
		const sparkline = options.sparklines?.get(asset.symbol);
		return formatDailyDigestPriceLine(
			asset,
			options.assetPrices.get(asset.symbol),
			sparkline,
			shouldShowDigestChangePercent(options.marketOpen, sparkline),
		);
	});
}

/** Build the plain-text "Your Assets" section for the digest. */
function buildDailyDigestPricesSummary(
	userAssets: UserAssetRow[],
	assetPrices: AssetPriceMap,
	sparklines?: SparklineMap,
	separator = "\n",
	marketOpen?: boolean,
): string {
	if (userAssets.length === 0) {
		return "";
	}
	return userAssets
		.map((asset) => {
			const sparkline = sparklines?.get(asset.symbol);
			return formatDailyDigestPriceLine(
				asset,
				assetPrices.get(asset.symbol),
				sparkline,
				shouldShowDigestChangePercent(marketOpen, sparkline),
			);
		})
		.join(separator);
}

/** Build the HTML "Your Assets" section for the digest. */
function buildDailyDigestPricesHtml(
	userAssets: UserAssetRow[],
	assetPrices: AssetPriceMap,
	sparklines?: SparklineMap,
	getLogoHtml?: (symbol: string) => string | undefined,
	marketOpen?: boolean,
): string {
	if (userAssets.length === 0) {
		return "";
	}
	return formatAssetsHtmlList(userAssets, (symbol) => assetPrices.get(symbol) ?? undefined, {
		getSparkline: (symbol) => sparklines?.get(symbol),
		getLogoHtml,
		getShowChangePercent: (symbol) =>
			shouldShowDigestChangePercent(marketOpen, sparklines?.get(symbol)),
	});
}

/** Format the daily digest payload for email delivery. */
export function formatDailyDigestEmail(options: {
	user: { id: string; email: string };
	/** User's 24-hour-time preference for the market-closed "as of" timestamp.
	 *  Defaults to 12-hour (the DB default) when omitted; production callers pass it. */
	is24Hour?: boolean;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: NotificationExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
	marketClosureInfo?: MarketClosureInfo | null;
	getLogoHtml?: (symbol: string) => string | undefined;
	/** Optional delay banner (text for plain-text body, inserted after header). */
	delayBannerText?: string | null;
	/** Optional delay banner (HTML for rich email body). */
	delayBannerHtml?: string | null;
}): { subject: string; text: string; html: string } {
	const urls = buildEmailUrls(options.user.id, options.user.email, "dailyNotifications");

	const news = ensureBlankLineBetweenTickerSnippets((options.extras.news ?? "").trim());
	const rumors = ensureBlankLineBetweenTickerSnippets((options.extras.rumors ?? "").trim());

	const ae = options.assetEvents;
	const earnings = (ae?.eventsSection?.earnings ?? "").trim();
	const dividends = (ae?.eventsSection?.dividends ?? "").trim();
	const splits = (ae?.eventsSection?.splits ?? "").trim();
	const ipos = (ae?.eventsSection?.ipos ?? "").trim();
	const analyst = (ae?.analystSection ?? "").trim();
	const insider = (ae?.insiderSection ?? "").trim();
	const topMovers = (options.extras.topMovers ?? "").trim();
	const prices = buildDailyDigestPricesSummary(
		options.userAssets,
		options.assetPrices,
		options.sparklines,
		"\n",
		options.marketOpen,
	);
	const pricesHtml = buildDailyDigestPricesHtml(
		options.userAssets,
		options.assetPrices,
		options.sparklines,
		options.getLogoHtml,
		options.marketOpen,
	);
	const closureInfo = options.marketClosureInfo ?? null;
	const showClosureBanner = options.marketOpen === false;
	// All three channels render the shared market-closed banner (with the same "as of"
	// quote-staleness hint) so the wording is identical — the digest no longer carries a
	// bespoke email-only variant.
	const closureAsOf = showClosureBanner
		? formatDigestQuoteAsOf(options.assetPrices, options.is24Hour ?? false)
		: null;
	const marketClosedText = showClosureBanner
		? buildMarketClosedBannerText(closureInfo, "prices", closureAsOf)
		: null;
	const marketClosedHtml = showClosureBanner
		? buildMarketClosedBannerHtml(closureInfo, "prices", closureAsOf)
		: "";
	const closureLabel = showClosureBanner
		? closureInfo
			? buildMarketClosureLabel(closureInfo)
			: "Market Closed"
		: null;
	const subject = closureLabel ? `Daily digest — ${closureLabel}` : "Daily digest";

	const sectionsText = [
		"StockTextAlerts — Your daily digest 🗓️",
		options.delayBannerText || "",
		marketClosedText ?? "",
		prices ? `💰 Your Assets\n${prices}` : "",
		news ? `\n🗞️ News\n${news}` : "",
		rumors ? `\n🤫 Rumors\n${rumors}` : "",
		earnings ? `\n📈 Earnings\n${earnings}` : "",
		dividends ? `\n💰 Dividends\n${dividends}` : "",
		splits ? `\n✂️ Splits\n${splits}` : "",
		ipos ? `\n🆕 Upcoming IPOs\n${ipos}` : "",
		analyst ? `\n📊 Analyst Consensus\n${analyst}` : "",
		insider ? `\n🏦 Insider Trades\n${insider}` : "",
		topMovers ? `\n🚀 Top Movers\n${topMovers}` : "",
		`\nManage your notifications: ${urls.dashboardUrl}`,
		`Manage your delivery schedule: ${urls.scheduleUrl}`,
		`Unsubscribe from all emails: ${urls.unsubscribeUrl}`,
		NOT_FINANCIAL_ADVICE,
	].filter(Boolean);

	const text = sectionsText.join("\n");

	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Daily Digest</h1>
	</div>
	<div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${options.delayBannerHtml || ""}
		${marketClosedHtml}
		${
			pricesHtml
				? `<h2 style="margin: 0 0 8px; font-size: 18px;">💰 Your Assets</h2>
		<div style="margin: 0 0 16px; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px; color: #374151;">${pricesHtml}</div>`
				: ""
		}
		${renderEmailSection("🗞️", "News", news, { showGrokLogo: true, showMassiveLogo: true })}
		${renderEmailSection("🤫", "Rumors", rumors, { showGrokLogo: true })}
		${renderEmailSection("📈", "Earnings", earnings, {
			showFinnhubLogo: true,
		})}
		${renderEmailSection("💰", "Dividends", dividends, {
			showMassiveLogo: true,
		})}
		${renderEmailSection("✂️", "Splits", splits, { showMassiveLogo: true })}
		${renderEmailSection("🆕", "Upcoming IPOs", ipos, {
			showMassiveLogo: true,
		})}
		${renderEmailSection("📊", "Analyst Consensus", analyst, { showFinnhubLogo: true })}
		${renderEmailSection("🏦", "Insider Trades", insider, { showFinnhubLogo: true })}
		${renderEmailSection("🚀", "Top Movers", topMovers, { showMassiveLogo: true })}
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

/** Render a daily digest as a Telegram message using parse-mode entities. */
export function formatDailyDigestTelegram(opts: {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: NotificationExtras;
	assetEvents?: AssetEventsResult;
	dateLabel: string;
	delayBanner?: string | null;
	marketClosedBanner?: string | null;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
}): FormattedString {
	let msg = fmt`${FormattedString.bold(`📊 Daily Digest · ${opts.dateLabel}`)}`;
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
		getSparkline: (symbol) => opts.sparklines?.get(symbol),
		showChangePercent: (symbol) =>
			shouldShowDigestChangePercent(opts.marketOpen, opts.sparklines?.get(symbol)),
	});

	if (opts.extras.topMovers) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📈 Top movers")}\n${opts.extras.topMovers}`;
	}
	if (opts.extras.news) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📰 News")}\n${FormattedString.blockquote(opts.extras.news)}`;
	}
	if (opts.extras.rumors) {
		msg = fmt`${msg}\n\n${FormattedString.bold("💬 Rumors")}\n${FormattedString.blockquote(opts.extras.rumors)}`;
	}

	const ae = opts.assetEvents;
	if (ae?.eventsSection?.earnings) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📅 Earnings")}\n${ae.eventsSection.earnings}`;
	}
	if (ae?.eventsSection?.dividends) {
		msg = fmt`${msg}\n\n${FormattedString.bold("💰 Ex-Dividend")}\n${ae.eventsSection.dividends}`;
	}
	if (ae?.eventsSection?.splits) {
		msg = fmt`${msg}\n\n${FormattedString.bold("✂️ Splits")}\n${ae.eventsSection.splits}`;
	}
	if (ae?.eventsSection?.ipos) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🆕 Upcoming IPOs")}\n${ae.eventsSection.ipos}`;
	}
	if (ae?.insiderSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🏦 Insider Trades")}\n${ae.insiderSection}`;
	}
	if (ae?.analystSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📊 Analyst Consensus (published monthly on the 1st)")}\n${ae.analystSection}`;
	}

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;
	return msg;
}
