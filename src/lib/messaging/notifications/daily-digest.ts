import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { buildAssetEventsContent } from "../../asset-events/content";
import { US_MARKET_TIMEZONE } from "../../constants";
import type { TopMover } from "../../market-data/types";
import {
	formatPredictionMarketsDigestEmailHtml,
	formatPredictionMarketsDigestTelegram,
	formatPredictionMarketsDigestText,
	formatPredictionMarketsEmailHtml,
	formatPredictionMarketsTelegram,
	formatPredictionMarketsText,
} from "../../prediction-markets/format";
import type { MarketClosureInfo } from "../../time/types";
import type { AssetPriceMap, UserAssetRow } from "../../types";
import { formatAssetsHtmlList } from "../email/asset-price-list";
import { renderEmailHtmlSection, renderEmailSection } from "../email/html-section";
import { buildEmailUrls, renderEmailFooter } from "../email/layout";
import {
	formatAssetTextLine,
	formatSignedChangePercent,
	formatUsdPrice,
} from "../parts/asset-price-list";
import { TELEGRAM_FOOTER } from "../parts/footer";
import {
	buildMarketClosedBannerEmailHtml,
	buildMarketClosedBannerEmailText,
	buildMarketClosedBannerTelegram,
	buildMarketClosureLabel,
} from "../parts/market-closure";
import type { SparklineData, SparklineMap } from "../parts/sparkline";
import { boldTickerPrefixesTelegram, isTickerPrefixLine } from "../parts/ticker-prefix";
import { appendTelegramAssetPriceLines } from "../telegram/asset-price-lines";
import type { NotificationExtras, TopMoversData } from "../types";

/** One top-mover line: `TICKER — $1,234.56 (+1.23%)`. Shared numeric primitives keep
 *  grouping/signs identical across channels. */
function formatTopMoverLine(mover: TopMover): string {
	return `${mover.ticker} — ${formatUsdPrice(mover.price)} (${formatSignedChangePercent(mover.changePercent)})`;
}

/**
 * Render the top-movers `Gainers:` / `Losers:` block body from structured data.
 * Reproduces the exact plain-text layout each digest channel wraps with its own
 * section header (email/Telegram render byte-identical bodies today). Returns
 * "" only if both lists are empty — callers gate on that to omit the section.
 */
function renderTopMoversBody(data: TopMoversData): string {
	const lines: string[] = [];
	if (data.gainers.length > 0) {
		lines.push("Gainers:");
		for (const m of data.gainers) lines.push(formatTopMoverLine(m));
	}
	if (data.losers.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Losers:");
		for (const m of data.losers) lines.push(formatTopMoverLine(m));
	}
	return lines.join("\n");
}

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
function formatDigestQuoteAsOf(assetPrices: AssetPriceMap, is24: boolean): string | null {
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
		const isTickerLine = isTickerPrefixLine(line);
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

/** Show change % on closed-market digests only when a 7-day sparkline anchors it. */
function shouldShowDigestChangePercent(
	marketOpen: boolean | undefined,
	sparkline?: SparklineData | null,
): boolean {
	if (marketOpen !== false) return true;
	return sparkline?.window === "7-trading-days" && sparkline.values.length >= 2;
}

/** Format a single asset price line for the plain-text digest. */
function formatDailyDigestPriceLine(
	asset: UserAssetRow,
	quote: { price: number; changePercent: number } | null | undefined,
	sparkline?: SparklineData | null,
	showChangePercent = true,
): string {
	return formatAssetTextLine(asset, quote ?? undefined, sparkline, showChangePercent);
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
	/** IANA timezone for prediction-market Updated/Closes labels. */
	timeZone?: string;
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
	const pmFormatOpts = {
		timeZone: options.timeZone ?? US_MARKET_TIMEZONE,
		use24Hour: options.is24Hour ?? false,
	};

	const news = ensureBlankLineBetweenTickerSnippets((options.extras.news ?? "").trim());
	const rumors = ensureBlankLineBetweenTickerSnippets((options.extras.rumors ?? "").trim());
	const predictionMarketsDigest = options.extras.predictionMarketsDigest ?? null;
	const predictionMarketsReadings = options.extras.predictionMarkets ?? null;
	const predictionMarketsText = predictionMarketsDigest
		? formatPredictionMarketsDigestText(predictionMarketsDigest, pmFormatOpts)
		: predictionMarketsReadings
			? formatPredictionMarketsText(predictionMarketsReadings)
			: null;
	const predictionMarketsHtml = predictionMarketsDigest
		? formatPredictionMarketsDigestEmailHtml(predictionMarketsDigest, pmFormatOpts)
		: predictionMarketsReadings
			? formatPredictionMarketsEmailHtml(predictionMarketsReadings)
			: null;

	const ae = options.assetEvents;
	const earnings = (ae?.eventsSection?.earnings ?? "").trim();
	const dividends = (ae?.eventsSection?.dividends ?? "").trim();
	const splits = (ae?.eventsSection?.splits ?? "").trim();
	const ipos = (ae?.eventsSection?.ipos ?? "").trim();
	const analyst = (ae?.analystSection ?? "").trim();
	const insider = (ae?.insiderSection ?? "").trim();
	const topMovers = options.extras.topMovers ? renderTopMoversBody(options.extras.topMovers) : "";
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
		? buildMarketClosedBannerEmailText(closureInfo, "prices", closureAsOf)
		: null;
	const marketClosedHtml = showClosureBanner
		? buildMarketClosedBannerEmailHtml(closureInfo, "prices", closureAsOf)
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
		predictionMarketsText ? `\n🎯 Prediction Markets\n${predictionMarketsText}` : "",
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
		${
			predictionMarketsHtml
				? renderEmailHtmlSection("🎯", "Prediction Markets", predictionMarketsHtml)
				: ""
		}
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
	marketClosureInfo?: MarketClosureInfo | null;
	/** User's 24-hour-time preference for the market-closed "as of" timestamp.
	 *  Defaults to 12-hour (the DB default) when omitted; production callers pass it. */
	is24Hour?: boolean;
	/** IANA timezone for prediction-market Updated/Closes labels. */
	timeZone?: string;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
}): FormattedString {
	// The Telegram channel renders its own market-closed banner from raw data (the
	// Telegram-specific price map + is24 flag) so its "as of" staleness hint matches
	// what this channel shows — no pre-rendered banner string is threaded in.
	const marketClosedBanner =
		opts.marketOpen === false
			? buildMarketClosedBannerTelegram(
					opts.marketClosureInfo,
					"prices",
					formatDigestQuoteAsOf(opts.assetPrices, opts.is24Hour ?? false),
				)
			: null;
	let msg = fmt`${FormattedString.bold(`📊 Daily Digest · ${opts.dateLabel}`)}`;
	if (opts.delayBanner) {
		msg = fmt`${msg}\n${opts.delayBanner}`;
	}
	if (marketClosedBanner) {
		msg = fmt`${msg}\n${marketClosedBanner}`;
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
		msg = fmt`${msg}\n\n${FormattedString.bold("📈 Top movers")}\n${boldTickerPrefixesTelegram(renderTopMoversBody(opts.extras.topMovers))}`;
	}
	if (opts.extras.news) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📰 News")}\n${FormattedString.blockquote(boldTickerPrefixesTelegram(opts.extras.news))}`;
	}
	if (opts.extras.rumors) {
		msg = fmt`${msg}\n\n${FormattedString.bold("💬 Rumors")}\n${FormattedString.blockquote(boldTickerPrefixesTelegram(opts.extras.rumors))}`;
	}
	const pmFormatOpts = {
		timeZone: opts.timeZone ?? US_MARKET_TIMEZONE,
		use24Hour: opts.is24Hour ?? false,
	};
	const predictionMarketsTelegram = opts.extras.predictionMarketsDigest
		? formatPredictionMarketsDigestTelegram(opts.extras.predictionMarketsDigest, pmFormatOpts)
		: opts.extras.predictionMarkets
			? formatPredictionMarketsTelegram(opts.extras.predictionMarkets)
			: null;
	if (predictionMarketsTelegram) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🎯 Prediction Markets")}\n${predictionMarketsTelegram}`;
	}

	const ae = opts.assetEvents;
	if (ae?.eventsSection?.earnings) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📅 Earnings")}\n${boldTickerPrefixesTelegram(ae.eventsSection.earnings)}`;
	}
	if (ae?.eventsSection?.dividends) {
		msg = fmt`${msg}\n\n${FormattedString.bold("💰 Ex-Dividend")}\n${boldTickerPrefixesTelegram(ae.eventsSection.dividends)}`;
	}
	if (ae?.eventsSection?.splits) {
		msg = fmt`${msg}\n\n${FormattedString.bold("✂️ Splits")}\n${boldTickerPrefixesTelegram(ae.eventsSection.splits)}`;
	}
	if (ae?.eventsSection?.ipos) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🆕 Upcoming IPOs")}\n${boldTickerPrefixesTelegram(ae.eventsSection.ipos)}`;
	}
	if (ae?.insiderSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("🏦 Insider Trades")}\n${boldTickerPrefixesTelegram(ae.insiderSection)}`;
	}
	if (ae?.analystSection) {
		msg = fmt`${msg}\n\n${FormattedString.bold("📊 Analyst Consensus (published monthly on the 1st)")}\n${boldTickerPrefixesTelegram(ae.analystSection)}`;
	}

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;
	return msg;
}
