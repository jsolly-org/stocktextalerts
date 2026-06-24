import type { buildAssetEventsContent } from "../asset-events/content";
import { US_MARKET_TIMEZONE } from "../constants";
import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { formatAssetsHtmlList, formatAssetTextLine } from "../messaging/asset-formatting";
import { renderEmailSection } from "../messaging/email/html-section";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls, renderEmailFooter } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import { NOT_FINANCIAL_ADVICE, SMS_OPT_OUT } from "../messaging/footer";
import {
	buildMarketClosedBannerHtml,
	buildMarketClosedBannerText,
	buildMarketClosureLabel,
} from "../messaging/market-closure-banner";
import { deliveryResultToLogFields, recordNotification } from "../messaging/shared";
import { packSmsBlocks, type SmsBlock } from "../messaging/sms/block-packing";
import type { SmsExtras } from "../messaging/sms/delivery";
import { formatExtrasSection } from "../messaging/sms/formatting";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { padDailyDigestSmsSegmentBoundaries } from "../messaging/sms/segment-utils";
import type { SparklineData, SparklineMap } from "../messaging/sparkline";
import { formatDailyDigestTelegram } from "../messaging/telegram/digest";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import type { DeliveryResult, UserAssetRow, UserRecord } from "../messaging/types";
import type { AssetPriceMap } from "../providers/price-fetcher";
import type { ScheduledNotificationTotals, SupabaseAdminClient } from "../schedule/helpers";
import { claimNotification, updateScheduledNotificationRow } from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import type { TelegramSenderProvider } from "../schedule/telegram-sender";
import type { MarketClosureInfo } from "../time/market-calendar";

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
	extras: SmsExtras;
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
			text: formatExtrasSection("🚀 Top Movers", options.extras.topMovers),
		},
		{ id: "news", boundary: "atomic", text: formatExtrasSection("🗞️ News", options.extras.news) },
		{
			id: "rumors",
			boundary: "atomic",
			text: formatExtrasSection("🤫 Rumors", options.extras.rumors),
		},
		{
			id: "earnings",
			boundary: "atomic",
			text: formatExtrasSection("📈 Earnings", ae?.eventsSection?.earnings),
		},
		{
			id: "dividends",
			boundary: "atomic",
			text: formatExtrasSection("💰 Dividends", ae?.eventsSection?.dividends),
		},
		{
			id: "splits",
			boundary: "atomic",
			text: formatExtrasSection("✂️ Splits", ae?.eventsSection?.splits),
		},
		{
			id: "ipos",
			boundary: "atomic",
			text: formatExtrasSection("🆕 Upcoming IPOs", ae?.eventsSection?.ipos),
		},
		{
			id: "analystConsensus",
			boundary: "atomic",
			text: formatExtrasSection("📊 Analyst Consensus", ae?.analystSection),
		},
		{
			id: "insiderTrades",
			boundary: "atomic",
			text: formatExtrasSection("🏦 Insider Trades", ae?.insiderSection),
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
	extras: SmsExtras;
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

/** Deliver a daily digest via email and record the result. */
export async function processDailyDigestEmailDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
	marketClosureInfo?: MarketClosureInfo | null;
	sendEmail: EmailSender;
	stats: ScheduledNotificationTotals;
	getLogoHtml?: (symbol: string) => string | undefined;
	delayBannerText?: string | null;
	delayBannerHtml?: string | null;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		sendEmail,
		stats,
	} = options;

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.emailsFailed++;
		return;
	}
	if (claim.status === "retries_exhausted" || claim.status === "not_ready") {
		stats.skipped++;
		return;
	}

	const message = formatDailyDigestEmail({
		user,
		is24Hour: user.use_24_hour_time,
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		sparklines: options.sparklines,
		marketOpen: options.marketOpen,
		marketClosureInfo: options.marketClosureInfo,
		getLogoHtml: options.getLogoHtml,
		delayBannerText: options.delayBannerText,
		delayBannerHtml: options.delayBannerHtml,
	});
	const result = await sendUserEmail(
		user,
		message.subject,
		{ text: message.text, html: message.html },
		sendEmail,
	);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "email",
		message_delivered: result.success,
		message: message.text,
		...deliveryResultToLogFields(result),
	});
	if (!logged) {
		stats.logFailures++;
	}

	if (result.success) {
		stats.emailsSent++;
	} else {
		stats.emailsFailed++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "email",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		attemptCount: claim.attemptCount,
		logger,
	});
}

/** Deliver a daily digest via SMS and record the result. */
export async function processDailyDigestSmsDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketOpen?: boolean;
	marketClosureInfo?: MarketClosureInfo | null;
	getSmsSender: SmsSenderProvider;
	stats: ScheduledNotificationTotals;
	/** Optional delay banner text for late notifications. */
	delayBanner?: string | null;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		getSmsSender,
		stats,
	} = options;

	if (!shouldSendSms(user)) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.smsFailed++;
		return;
	}
	if (claim.status === "retries_exhausted" || claim.status === "not_ready") {
		stats.skipped++;
		return;
	}

	let smsSenderResult: ReturnType<SmsSenderProvider>;
	try {
		smsSenderResult = getSmsSender();
	} catch (error) {
		stats.smsFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve SMS sender for daily digest",
			{ userId: user.id, scheduledDate, scheduledMinutes },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "sms",
			status: "failed",
			error: errorMessage,
			attemptCount: claim.attemptCount,
			logger,
		});
		return;
	}

	const smsMessages = formatDailyDigestSmsMessages({
		userAssets,
		assetPrices,
		extras,
		assetEvents,
		sparklines: options.sparklines,
		marketOpen: options.marketOpen,
		marketClosureInfo: options.marketClosureInfo,
		is24Hour: user.use_24_hour_time,
		delayBanner: options.delayBanner,
	});
	const partResults: DeliveryResult[] = [];
	for (const [index, smsMessage] of smsMessages.entries()) {
		const partResult = await sendUserSms(user, smsMessage, smsSenderResult.sender, supabase);
		partResults.push(partResult);

		if (!partResult.success) {
			logger.error(
				"Failed to send Daily Digest SMS part",
				{
					userId: user.id,
					scheduledDate,
					scheduledMinutes,
					partNumber: index + 1,
					totalParts: smsMessages.length,
					partLength: smsMessage.length,
					errorCode: partResult.errorCode ?? null,
				},
				new Error(partResult.error ?? "Daily Digest SMS part failed"),
			);
			break;
		}
	}

	const result = summarizeDailyDigestSmsResults(partResults, smsMessages.length);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "sms",
		message_delivered: result.success,
		message: formatDailyDigestSmsLogMessage(smsMessages),
		...deliveryResultToLogFields(result),
	});
	if (!logged) {
		stats.logFailures++;
	}

	if (result.success) {
		stats.smsSent++;
	} else {
		stats.smsFailed++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "sms",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		attemptCount: claim.attemptCount,
		logger,
	});
}

/**
 * Deliver a daily digest via Telegram and record the result.
 *
 * Mirrors `processDailyDigestSmsDelivery` but renders the Telegram-native digest
 * (parse-mode entities, no SMS segment limit) and sends a single message via the
 * Telegram sender. v1 content is prices (+ top movers when the user enabled that
 * facet for Telegram); Grok news/rumors are intentionally omitted from `extras`
 * by the caller. Claims the `telegram` channel of the daily slot so it retries
 * and advances independently of email/SMS.
 */
export async function processDailyDigestTelegramDelivery(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	scheduledDate: string;
	scheduledMinutes: number;
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	extras: SmsExtras;
	/** Human date label in market tz, e.g. "Thu, Jun 19". */
	dateLabel: string;
	marketClosedBanner?: string | null;
	getTelegramSender: TelegramSenderProvider;
	stats: ScheduledNotificationTotals;
}): Promise<void> {
	const {
		user,
		supabase,
		logger,
		scheduledDate,
		scheduledMinutes,
		userAssets,
		assetPrices,
		extras,
		dateLabel,
		marketClosedBanner,
		getTelegramSender,
		stats,
	} = options;

	// Channel usability is re-checked here (chat linked + not opted out) so a
	// concurrent opt-out between content prep and delivery is honored.
	if (!isTelegramChannelUsable(user) || user.telegram_chat_id == null) {
		return;
	}

	const claim = await claimNotification({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		logger,
	});
	if (claim.status === "claim_error") {
		stats.telegramFailed++;
		return;
	}
	if (claim.status === "retries_exhausted" || claim.status === "not_ready") {
		stats.skipped++;
		return;
	}

	let telegramSenderResult: ReturnType<TelegramSenderProvider>;
	try {
		telegramSenderResult = getTelegramSender();
	} catch (error) {
		stats.telegramFailed++;
		const errorMessage = extractErrorMessage(error);
		logger.error(
			"Failed to resolve Telegram sender for daily digest",
			{ userId: user.id, scheduledDate, scheduledMinutes },
			createErrorForLogging(error),
		);
		await updateScheduledNotificationRow({
			supabase,
			userId: user.id,
			notificationType: "daily",
			scheduledDate,
			scheduledMinutes,
			channel: "telegram",
			status: "failed",
			error: errorMessage,
			attemptCount: claim.attemptCount,
			logger,
		});
		return;
	}

	const formatted = formatDailyDigestTelegram({
		userAssets,
		assetPrices,
		extras,
		dateLabel,
		marketClosedBanner,
	});

	const result = await telegramSenderResult.sender({
		chatId: user.telegram_chat_id,
		text: formatted.text,
		entities: formatted.entities,
		// Routine scheduled digest — deliver silently like other passive updates.
		disableNotification: true,
	});

	if (!result.success) {
		logger.error(
			"Failed to send Daily Digest Telegram message",
			{
				userId: user.id,
				scheduledDate,
				scheduledMinutes,
				errorCode: result.errorCode ?? null,
			},
			new Error(result.error ?? "Daily Digest Telegram send failed"),
		);
	}

	await optOutIfBotBlocked(supabase, user.id, result, logger);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "telegram",
		message_delivered: result.success,
		message: formatted.text,
		...deliveryResultToLogFields(result),
	});
	if (!logged) {
		stats.logFailures++;
	}

	if (result.success) {
		stats.telegramSent++;
	} else {
		stats.telegramFailed++;
	}

	await updateScheduledNotificationRow({
		supabase,
		userId: user.id,
		notificationType: "daily",
		scheduledDate,
		scheduledMinutes,
		channel: "telegram",
		status: result.success ? "sent" : "failed",
		error: result.success ? undefined : result.error,
		attemptCount: claim.attemptCount,
		logger,
	});
}
