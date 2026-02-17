import type { buildAssetEventsContent } from "../asset-events/content";
import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import { createErrorForLogging, extractErrorMessage } from "../logging/errors";
import { escapeHtml, getChangeColor } from "../messaging/asset-formatting";
import { renderEmailSection } from "../messaging/email/html-section";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls, renderEmailFooter } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import { recordNotification } from "../messaging/shared";
import type { SmsExtras } from "../messaging/sms/delivery";
import { formatExtrasSection } from "../messaging/sms/formatting";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import type { SparklineData, SparklineMap } from "../messaging/sparkline";
import { toSvgSparklineImg } from "../messaging/svg-sparkline";
import type {
	FormatPreferences,
	UserAssetRow,
	UserRecord,
} from "../messaging/types";
import type { AssetPriceMap } from "../providers/price-fetcher";
import type {
	ScheduledNotificationTotals,
	SupabaseAdminClient,
} from "../schedule/helpers";
import {
	claimNotification,
	updateScheduledNotificationRow,
} from "../schedule/helpers";
import type { SmsSenderProvider } from "../schedule/sms-sender";
import type { MarketClosureInfo } from "../time/market-calendar";

const TICKER_LINE_RE = /^[A-Z][A-Z0-9.-]{0,9}:\s/;
const MARKET_TIME_ZONE = "America/New_York";

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

/** Extract the latest quote timestamp from asset prices, if any. */
function getLatestQuoteTimestamp(assetPrices: AssetPriceMap): number | null {
	let latestTimestamp: number | null = null;

	for (const quote of assetPrices.values()) {
		if (!quote || typeof quote.timestamp !== "number") continue;
		if (!Number.isFinite(quote.timestamp) || quote.timestamp <= 0) continue;
		latestTimestamp =
			latestTimestamp === null
				? quote.timestamp
				: Math.max(latestTimestamp, quote.timestamp);
	}

	return latestTimestamp;
}

/** Format a Unix timestamp in Eastern time for display. */
function formatQuoteTimestamp(timestamp: number): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: MARKET_TIME_ZONE,
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(new Date(timestamp * 1000));
}

/** Build a human-readable market closure label. */
function buildMarketClosureLabel(closureInfo: MarketClosureInfo): string {
	if (closureInfo.reason === "holiday" && closureInfo.holidayName) {
		return `Market Closed — ${closureInfo.holidayName}`;
	}
	if (closureInfo.reason === "weekend") {
		return "Market Closed — Weekend";
	}
	return "Market Closed";
}

/** Build a plain-text market-closed banner for the digest. */
function buildDigestMarketClosedText(
	closureInfo: MarketClosureInfo,
	assetPrices: AssetPriceMap,
): string {
	const label = buildMarketClosureLabel(closureInfo);
	const ts = getLatestQuoteTimestamp(assetPrices);
	const asOf = ts ? ` (as of ${formatQuoteTimestamp(ts)})` : "";
	return `🔔 ${label}\nPrices below reflect the last market close${asOf}.`;
}

/** Build an HTML market-closed banner for the digest. */
function buildDigestMarketClosedHtml(
	closureInfo: MarketClosureInfo,
	assetPrices: AssetPriceMap,
): string {
	const label = escapeHtml(buildMarketClosureLabel(closureInfo));
	const ts = getLatestQuoteTimestamp(assetPrices);
	const asOf = ts ? ` (as of ${escapeHtml(formatQuoteTimestamp(ts))})` : "";
	return `<div style="background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; text-align: center;">
			<div style="font-size: 14px; color: #92400e; font-weight: 600;">🔔 ${label}</div>
			<div style="font-size: 12px; color: #92400e; margin-top: 4px;">Prices below reflect the last market close${asOf}.</div>
		</div>`;
}

export type AssetEventsResult = Awaited<
	ReturnType<typeof buildAssetEventsContent>
> | null;

/** Format the daily digest message body for SMS delivery. */
export function formatDailyDigestSmsMessage(options: {
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	formatPrefs: FormatPreferences;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
}): string {
	const optOutSuffix = "Reply STOP to opt out.";
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const prices = buildDailyDigestPricesSummary(
		options.userAssets,
		options.assetPrices,
		options.formatPrefs,
		options.sparklines,
		"\n\n",
	);

	const ae = options.assetEvents;
	const sections = [
		"StockTextAlerts — Your daily digest 🗓️",
		prices ? `💰 Your Assets\n${prices}` : "",
		formatExtrasSection("🗞️ News", options.extras.news),
		formatExtrasSection("🤫 Rumors", options.extras.rumors),
		formatExtrasSection("📈 Earnings", ae?.eventsSection?.earnings),
		formatExtrasSection("💰 Dividends", ae?.eventsSection?.dividends),
		formatExtrasSection("✂️ Splits", ae?.eventsSection?.splits),
		formatExtrasSection("🆕 Upcoming IPOs", ae?.eventsSection?.ipos),
		formatExtrasSection("📊 Analyst Consensus", ae?.analystSection),
		formatExtrasSection("🏦 Insider Trades", ae?.insiderSection),
		`Manage your settings: ${dashboardUrl}`,
		optOutSuffix,
	].filter((value) => Boolean(value));

	return sections.join("\n\n");
}

/** Format a single asset price line for the SMS/plain-text digest. */
function formatDailyDigestPriceLine(
	asset: UserAssetRow,
	quote: { price: number; changePercent: number } | null | undefined,
	formatPrefs: FormatPreferences,
	sparkline?: SparklineData | null,
): string {
	const base = asset.symbol;
	if (!quote) {
		return `${base} — price unavailable`;
	}
	const sign = quote.changePercent >= 0 ? "+" : "";
	const priceStr = `$${quote.price.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`;
	const ascii =
		formatPrefs.show_sparklines && sparkline?.ascii
			? ` ${sparkline.ascii}`
			: "";
	return `${base} — ${priceStr}${ascii}`;
}

/** Format a single asset price line for the HTML digest. */
function formatDailyDigestPriceLineHtml(
	asset: UserAssetRow,
	quote: { price: number; changePercent: number } | null | undefined,
	formatPrefs: FormatPreferences,
	sparkline?: SparklineData | null,
): string {
	const symbol = escapeHtml(asset.symbol);
	if (!quote) {
		return `<div style="margin-bottom: 8px;">${symbol} &mdash; <span style="color: #6b7280;">price unavailable</span></div>`;
	}
	const priceStr = escapeHtml(`$${quote.price.toFixed(2)}`);
	const sign = quote.changePercent >= 0 ? "+" : "";
	const color = getChangeColor(quote.changePercent);
	const changeStr = escapeHtml(`(${sign}${quote.changePercent.toFixed(2)}%)`);

	let sparklineHtml = "";
	if (
		formatPrefs.show_sparklines &&
		sparkline?.values &&
		sparkline.values.length >= 2
	) {
		sparklineHtml = ` ${toSvgSparklineImg(sparkline.values, color)}`;
	}

	return `<div style="margin-bottom: 8px;">${symbol} &mdash; ${priceStr} <span style="color: ${color}; font-weight: 600;">${changeStr}</span>${sparklineHtml}</div>`;
}

/** Build the plain-text “Your Assets” section for the digest. */
function buildDailyDigestPricesSummary(
	userAssets: UserAssetRow[],
	assetPrices: AssetPriceMap,
	formatPrefs: FormatPreferences,
	sparklines?: SparklineMap,
	separator = "\n",
): string {
	if (userAssets.length === 0) {
		return "";
	}
	return userAssets
		.map((asset) =>
			formatDailyDigestPriceLine(
				asset,
				assetPrices.get(asset.symbol),
				formatPrefs,
				sparklines?.get(asset.symbol),
			),
		)
		.join(separator);
}

/** Build the HTML “Your Assets” section for the digest. */
function buildDailyDigestPricesHtml(
	userAssets: UserAssetRow[],
	assetPrices: AssetPriceMap,
	formatPrefs: FormatPreferences,
	sparklines?: SparklineMap,
): string {
	if (userAssets.length === 0) {
		return "";
	}
	return userAssets
		.map((asset) =>
			formatDailyDigestPriceLineHtml(
				asset,
				assetPrices.get(asset.symbol),
				formatPrefs,
				sparklines?.get(asset.symbol),
			),
		)
		.join("");
}

/** Format the daily digest payload for email delivery. */
export function formatDailyDigestEmail(options: {
	user: { id: string; email: string };
	userAssets: UserAssetRow[];
	assetPrices: AssetPriceMap;
	formatPrefs: FormatPreferences;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketClosureInfo?: MarketClosureInfo | null;
}): { subject: string; text: string; html: string } {
	const tickers = options.userAssets.map((s) => s.symbol).filter(Boolean);
	const tickersLine =
		tickers.length > 0 ? `Tickers: ${tickers.join(", ")}` : "(none)";
	const urls = buildEmailUrls(
		options.user.id,
		options.user.email,
		"dailyNotifications",
	);

	const news = ensureBlankLineBetweenTickerSnippets(
		(options.extras.news ?? "").trim(),
	);
	const rumors = ensureBlankLineBetweenTickerSnippets(
		(options.extras.rumors ?? "").trim(),
	);

	const ae = options.assetEvents;
	const earnings = (ae?.eventsSection?.earnings ?? "").trim();
	const dividends = (ae?.eventsSection?.dividends ?? "").trim();
	const splits = (ae?.eventsSection?.splits ?? "").trim();
	const ipos = (ae?.eventsSection?.ipos ?? "").trim();
	const analyst = (ae?.analystSection ?? "").trim();
	const insider = (ae?.insiderSection ?? "").trim();
	const prices = buildDailyDigestPricesSummary(
		options.userAssets,
		options.assetPrices,
		options.formatPrefs,
		options.sparklines,
		"\n",
	);
	const digestTickerBody = prices || tickersLine;
	const pricesHtml =
		buildDailyDigestPricesHtml(
			options.userAssets,
			options.assetPrices,
			options.formatPrefs,
			options.sparklines,
		) || escapeHtml(tickersLine);
	const closureInfo = options.marketClosureInfo ?? null;
	const marketClosedText = closureInfo
		? buildDigestMarketClosedText(closureInfo, options.assetPrices)
		: null;
	const marketClosedHtml = closureInfo
		? buildDigestMarketClosedHtml(closureInfo, options.assetPrices)
		: "";

	const sectionsText = [
		"StockTextAlerts — Your daily digest 🗓️",
		marketClosedText ?? "",
		`💰 Your Assets\n${digestTickerBody}`,
		news ? `\n🗞️ News\n${news}` : "",
		rumors ? `\n🤫 Rumors\n${rumors}` : "",
		earnings ? `\n📈 Earnings\n${earnings}` : "",
		dividends ? `\n💰 Dividends\n${dividends}` : "",
		splits ? `\n✂️ Splits\n${splits}` : "",
		ipos ? `\n🆕 Upcoming IPOs\n${ipos}` : "",
		analyst ? `\n📊 Analyst Consensus\n${analyst}` : "",
		insider ? `\n🏦 Insider Trades\n${insider}` : "",
		`\nManage your settings: ${urls.dashboardUrl}`,
		`Manage your delivery schedule: ${urls.scheduleUrl}`,
		`Unsubscribe: ${urls.unsubscribeUrl}`,
	].filter(Boolean);

	const subject = "Daily digest";
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
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">📈 StockTextAlerts</h1>
	</div>
	<div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${marketClosedHtml}
		<h2 style="margin: 0 0 8px; font-size: 18px;">💰 Your Assets</h2>
		<div style="margin: 0 0 16px; padding: 12px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${pricesHtml}</div>
		${renderEmailSection("🗞️", "News", news, { showGrokLogo: true, showMassiveLogo: true })}
		${renderEmailSection("🤫", "Rumors", rumors, { showGrokLogo: true })}
		${renderEmailSection("📈", "Earnings", earnings)}
		${renderEmailSection("💰", "Dividends", dividends)}
		${renderEmailSection("✂️", "Splits", splits)}
		${renderEmailSection("🆕", "Upcoming IPOs", ipos)}
		${renderEmailSection("📊", "Analyst Consensus", analyst, { showFinnhubLogo: true })}
		${renderEmailSection("🏦", "Insider Trades", insider, { showFinnhubLogo: true })}
		<div style="text-align: center; margin-top: 20px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your settings →
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
	formatPrefs: FormatPreferences;
	extras: SmsExtras;
	assetEvents?: AssetEventsResult;
	sparklines?: SparklineMap;
	marketClosureInfo?: MarketClosureInfo | null;
	sendEmail: EmailSender;
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
		formatPrefs,
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
	if (claim.status === "retries_exhausted") {
		stats.skipped++;
		return;
	}

	const emailIdempotencyKey = `daily-digest/${user.id}/${scheduledDate}/${scheduledMinutes}/email`;
	const message = formatDailyDigestEmail({
		user,
		userAssets,
		assetPrices,
		formatPrefs,
		extras,
		assetEvents,
		sparklines: options.sparklines,
		marketClosureInfo: options.marketClosureInfo,
	});
	const result = await sendUserEmail(
		user,
		message.subject,
		{ text: message.text, html: message.html },
		sendEmail,
		emailIdempotencyKey,
	);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "email",
		message_delivered: result.success,
		message: message.text,
		error: result.success ? undefined : result.error,
		error_code: result.success ? undefined : result.errorCode,
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
	getSmsSender: SmsSenderProvider;
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
	if (claim.status === "retries_exhausted") {
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
			{ userId: user.id, scheduledDate, scheduledMinutes, errorMessage },
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
			logger,
		});
		return;
	}

	const smsMessage = formatDailyDigestSmsMessage({
		userAssets,
		assetPrices,
		formatPrefs: {
			show_sparklines: user.show_sparklines,
		},
		extras,
		assetEvents,
		sparklines: options.sparklines,
	});
	const result = await sendUserSms(user, smsMessage, smsSenderResult.sender);
	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "daily",
		delivery_method: "sms",
		message_delivered: result.success,
		message: smsMessage,
		error: result.success ? undefined : result.error,
		error_code: result.success ? undefined : result.errorCode,
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
		logger,
	});
}
