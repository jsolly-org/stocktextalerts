import { DateTime } from "luxon";
import {
	US_MARKET_OPEN_EASTERN_MINUTES,
	US_MARKET_TIMEZONE,
} from "../constants";
import { getSiteUrl } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import {
	escapeHtml,
	getChangeColor,
	getSafeHrefUrl,
} from "../messaging/asset-formatting";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import {
	createLogoCache,
	fetchLogoBase64,
	renderLogoImg,
} from "../messaging/logo-fetcher";
import {
	deliveryResultToLogFields,
	recordNotification,
} from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { padUrlsToSegmentBoundaries } from "../messaging/sms/segment-utils";
import type { SmsSender } from "../messaging/sms/twilio-utils";
import { shortenUrl, shortenUrls } from "../messaging/sms/url-shortener";
import { toSparkline } from "../messaging/sparkline";
import {
	type SparklineTimeLabel,
	toSvgSparklineImg,
} from "../messaging/svg-sparkline";
import type { EnrichedAlert } from "./enrichment";
import type { PriceAlertLink } from "./grok-summary";
import type { PriceAlertUser } from "./users";

/** Max sparkline length for SMS. Unicode blocks use UCS-2 (70 chars/segment). Truncating reduces segment count and cost. */
const SMS_SPARKLINE_MAX_LENGTH = 12;

function formatPriceContextWithSparkline(
	priceContext: string,
	intradayCloses: number[] | null,
	maxSparklineLength?: number,
): string {
	if (!intradayCloses) return priceContext;

	let values = intradayCloses;
	if (maxSparklineLength !== undefined && maxSparklineLength < 2) {
		return priceContext;
	}
	if (maxSparklineLength !== undefined && values.length > maxSparklineLength) {
		// Downsample to preserve full-day shape; truncating would drop recent price data
		const sampled: number[] = [];
		for (let i = 0; i < maxSparklineLength; i++) {
			const idx = Math.round(
				(i / (maxSparklineLength - 1)) * (values.length - 1),
			);
			sampled.push(values[idx]);
		}
		values = sampled;
	}

	const sparkline = toSparkline(values);
	return sparkline ? `${priceContext} Today: ${sparkline}` : priceContext;
}

/** Per-run delivery counters for price alerts (email/SMS success/fail and log failures). */
export interface PriceAlertDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	logFailures: number;
}

/**
 * Format the SMS body for a price alert.
 */
async function formatPriceAlertSms(
	alert: EnrichedAlert,
	supabase: AppSupabaseClient,
): Promise<string> {
	const rawDashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const dashboardUrl = await shortenUrl(rawDashboardUrl, supabase);
	const optOutSuffix = "Reply STOP to opt out.";

	const priceContextLine = formatPriceContextWithSparkline(
		alert.priceContext,
		alert.intradayCloses,
		SMS_SPARKLINE_MAX_LENGTH,
	);

	const sections = [
		"StockTextAlerts — Asset Price Alert 🚨",
		priceContextLine,
		`Signals: ${alert.signalContext}`,
	];

	if (alert.grokResult) {
		const { summary, links } = alert.grokResult;
		const rawUrls = links
			.map((l) => getSafeHrefUrl(l.url))
			.filter((url): url is string => url !== null);
		const urlMap = await shortenUrls(rawUrls, supabase);
		const linkLines = rawUrls.map((url) => urlMap.get(url) ?? url).join("\n");
		sections.push(linkLines ? `${summary}\n${linkLines}` : summary);
	}

	sections.push(`Manage your settings: ${dashboardUrl}`);
	sections.push(optOutSuffix);

	return padUrlsToSegmentBoundaries(sections.join("\n\n"));
}

/** Format minutes-from-midnight as compact time for sparkline axis labels.
 *  12h: "9:30a", "2p", "12:45p"   24h: "9:30", "14:00", "12:45" */
function formatCompactTime(totalMinutes: number, is24: boolean): string {
	const h24 = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (is24) {
		return `${h24}:${String(m).padStart(2, "0")}`;
	}
	const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
	const period = h24 >= 12 ? "p" : "a";
	return m === 0
		? `${h12}${period}`
		: `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/** Market-open timestamp (ms) for the calendar day of the given timestamp, in ET. */
function getMarketOpenTimestampMs(referenceMs: number): number {
	const marketOpenHour = Math.floor(US_MARKET_OPEN_EASTERN_MINUTES / 60);
	const marketOpenMinute = US_MARKET_OPEN_EASTERN_MINUTES % 60;
	return DateTime.fromMillis(referenceMs)
		.setZone(US_MARKET_TIMEZONE)
		.startOf("day")
		.set({
			hour: marketOpenHour,
			minute: marketOpenMinute,
			second: 0,
			millisecond: 0,
		})
		.toMillis();
}

/** Convert timestamp (ms) to minutes-from-midnight in ET. */
function getMinutesFromMidnightET(ms: number): number {
	const dt = DateTime.fromMillis(ms).setZone(US_MARKET_TIMEZONE);
	return dt.hour * 60 + dt.minute;
}

/** Build time-axis labels for an intraday sparkline anchored to market open (9:30 ET).
 *  Returns empty when endTimestampMs is missing. Axis spans market-open to end (not first-bar to end). */
function buildIntradayTimeLabels(
	is24: boolean,
	endTimestampMs: number | null | undefined,
): SparklineTimeLabel[] {
	if (endTimestampMs == null) return [];

	const marketOpenMs = getMarketOpenTimestampMs(endTimestampMs);
	const startMinutes = getMinutesFromMidnightET(marketOpenMs);
	const endMinutes = getMinutesFromMidnightET(endTimestampMs);

	const totalSpan = endMinutes - startMinutes;
	if (totalSpan <= 0) return [];

	const labels: SparklineTimeLabel[] = [
		{ position: 0, label: formatCompactTime(startMinutes, is24) },
	];

	// Add hourly ticks between start and end (if room)
	if (totalSpan > 60) {
		const firstHour = Math.ceil(startMinutes / 60) * 60;
		for (let min = firstHour; min < endMinutes; min += 60) {
			const pos = (min - startMinutes) / totalSpan;
			// Suppress ticks within 15% of start/end to avoid crowding the edge labels
			// (e.g., a 10:00 AM tick at pos≈0.08 would overlap "9:30a" for a full session).
			if (pos > 0.15 && pos < 0.85) {
				labels.push({ position: pos, label: formatCompactTime(min, is24) });
			}
		}
	}

	labels.push({ position: 1, label: formatCompactTime(endMinutes, is24) });
	return labels;
}

function renderHtmlSparkline(
	intradayCloses: number[] | null,
	is24: boolean,
	endTimestampMs?: number | null,
	timestamps?: (number | null)[] | null,
): string {
	if (!intradayCloses || intradayCloses.length < 2) return "";
	if (intradayCloses.some((v) => !Number.isFinite(v))) return "";
	const openPrice = intradayCloses[0];
	const lastPrice = intradayCloses[intradayCloses.length - 1];
	const changePercent =
		openPrice === 0 ? 0 : ((lastPrice - openPrice) / openPrice) * 100;
	const color = getChangeColor(changePercent);
	const timeLabels = buildIntradayTimeLabels(is24, endTimestampMs);
	const marketOpenMs =
		endTimestampMs != null ? getMarketOpenTimestampMs(endTimestampMs) : null;
	const timeAxis =
		timestamps &&
		timestamps.length === intradayCloses.length &&
		marketOpenMs != null &&
		endTimestampMs != null
			? {
					timestamps,
					startTimestamp: marketOpenMs,
					endTimestamp: endTimestampMs,
				}
			: undefined;
	const sparklineImg = toSvgSparklineImg(
		intradayCloses,
		color,
		200,
		40,
		"Intraday price chart since market open",
		timeLabels,
		timeAxis,
	);
	if (!sparklineImg) return "";
	return `
			<p style="color: #92400e; font-size: 12px; margin: 8px 0 0 0;">Today since open:</p>
			<div style="margin-top: 4px;">${sparklineImg}</div>`;
}

function renderHtmlSparklineForAlert(
	alert: EnrichedAlert,
	is24: boolean,
): string {
	return renderHtmlSparkline(
		alert.intradayCloses,
		is24,
		alert.intradayEndTimestamp,
		alert.intradayTimestamps,
	);
}

/** Build the "Why it's moving" HTML section for price alert emails. */
function buildWhyMovingHtml(grokResult: EnrichedAlert["grokResult"]): string {
	if (!grokResult) return "";

	const summaryHtml = `
		<div style="margin-top: 16px; padding: 12px 16px; background: #f9fafb; border-radius: 6px; border-left: 3px solid #f59e0b;">
			<p style="color: #4b5563; font-size: 14px; margin: 0; font-style: italic;">${escapeHtml(grokResult.summary)}</p>
		</div>`;

	if (grokResult.links.length === 0) {
		return `
		<div style="margin-top: 20px;">
			<h3 style="color: #1f2937; font-size: 16px; font-weight: 600; margin: 0 0 10px 0;">Why it's moving</h3>
			${summaryHtml}
		</div>`;
	}

	const linksHtml = grokResult.links
		.map((link: PriceAlertLink) => {
			const title = escapeHtml(link.title);
			const safeUrl = getSafeHrefUrl(link.url);
			const viaLabel =
				link.sourceType === "x"
					? `via ${escapeHtml(link.source)} on X`
					: `via ${escapeHtml(link.source)}`;
			const linkEl = safeUrl
				? `<a href="${escapeHtml(safeUrl)}" style="color: #667eea; text-decoration: none;">${title}</a>`
				: title;
			return `<li style="margin-bottom: 6px;">${linkEl} <span style="color: #9ca3af;">(${viaLabel})</span></li>`;
		})
		.join("\n\t\t\t\t");

	return `
		<div style="margin-top: 20px;">
			<h3 style="color: #1f2937; font-size: 16px; font-weight: 600; margin: 0 0 10px 0;">Why it's moving</h3>
			${summaryHtml}
			<ul style="margin: 10px 0 0 0; padding-left: 20px; color: #4b5563;">
				${linksHtml}
			</ul>
		</div>`;
}

/**
 * Format the email body for a price alert.
 */
function formatPriceAlertEmail(
	user: PriceAlertUser,
	alert: EnrichedAlert,
	logoHtml?: string,
): { text: string; html: string } {
	const urls = buildEmailUrls(user.id, user.email, "marketNotifications");

	// Plaintext
	const textPriceContextLine = formatPriceContextWithSparkline(
		alert.priceContext,
		alert.intradayCloses,
	);

	const textSections = [
		`Asset Price Alert: ${alert.symbol}`,
		textPriceContextLine,
		`Signals: ${alert.signalContext}`,
	];

	if (alert.grokResult) {
		const { summary, links } = alert.grokResult;
		textSections.push(`Why it's moving:\n${summary}`);
		if (links.length > 0) {
			const linkLines = links
				.map((l) => {
					const via =
						l.sourceType === "x" ? `via ${l.source} on X` : `via ${l.source}`;
					const safeUrl = getSafeHrefUrl(l.url);
					return `- ${l.title} (${via})${safeUrl ? ` ${safeUrl}` : ""}`;
				})
				.join("\n");
			textSections.push(linkLines);
		}
	}

	textSections.push(`Manage your settings: ${urls.scheduleUrl}`);
	textSections.push(`Unsubscribe from all emails: ${urls.unsubscribeUrl}`);

	const text = textSections.join("\n\n");

	// HTML

	const whyMovingHtml = buildWhyMovingHtml(alert.grokResult);

	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Asset Price Alert</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">${logoHtml ?? ""}${escapeHtml(alert.symbol)}</h2>
		<div style="background: #fffbeb; padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #fde68a;">
			<p style="color: #92400e; font-size: 16px; font-weight: 500; margin: 0;">${escapeHtml(alert.priceContext)}</p>${renderHtmlSparklineForAlert(alert, user.use_24_hour_time)}
		</div>
		<div style="margin-bottom: 20px;">
			<p style="color: #6b7280; font-size: 14px; margin: 0;"><strong>Signals:</strong> ${escapeHtml(alert.signalContext)}</p>
		</div>
		${whyMovingHtml}
		<div style="text-align: center; margin-top: 30px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				View Dashboard →
			</a>
		</div>
		<p style="color: #6b7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
			<a href="${urls.escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Manage alerts</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${urls.escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from all emails</a>
		</p>
	</div>
</body>
</html>`;

	return { text, html };
}

/**
 * Deliver a price alert to a user via their preferred channels.
 */
export async function deliverPriceAlert(options: {
	user: PriceAlertUser;
	alert: EnrichedAlert;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	stats: PriceAlertDeliveryStats;
	logoCache?: ReturnType<typeof createLogoCache>;
}): Promise<void> {
	const { user, alert, supabase, sendEmail, sendSms, stats, logoCache } =
		options;

	// Email delivery
	if (user.market_asset_price_alerts_include_email) {
		const effectiveLogoCache = logoCache ?? createLogoCache();
		const logoDataUri = await fetchLogoBase64(
			alert.symbol,
			alert.iconUrl,
			effectiveLogoCache,
			alert.iconBase64,
			supabase,
		);
		const logoHtml = logoDataUri ? renderLogoImg(logoDataUri) : undefined;
		const message = formatPriceAlertEmail(user, alert, logoHtml);
		const result = await sendUserEmail(
			user,
			`${alert.symbol} ${alert.isPositiveMove ? "Rally" : "Selloff"} Alert`,
			message,
			sendEmail,
		);

		if (result.success) {
			stats.emailsSent++;
		} else {
			stats.emailsFailed++;
		}

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "price_alert",
			delivery_method: "email",
			message_delivered: result.success,
			message: message.text,
			...deliveryResultToLogFields(result),
		});
		if (!logged) stats.logFailures++;
	}

	// SMS delivery
	if (user.market_asset_price_alerts_include_sms && sendSms) {
		if (!shouldSendSms(user)) {
			rootLogger.info("Price alert SMS skipped: user not eligible", {
				userId: user.id,
			});
			stats.smsFailed++;
		} else if (!user.phone_country_code || !user.phone_number) {
			rootLogger.warn("Price alert SMS skipped: no phone number", {
				userId: user.id,
			});
			stats.smsFailed++;
		} else {
			const smsBody = await formatPriceAlertSms(alert, supabase);
			const result = await sendUserSms(user, smsBody, sendSms);

			if (result.success) {
				stats.smsSent++;
			} else {
				stats.smsFailed++;
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "price_alert",
				delivery_method: "sms",
				message_delivered: result.success,
				message: smsBody,
				...deliveryResultToLogFields(result),
			});
			if (!logged) stats.logFailures++;
		}
	}
}
