import { getSiteUrl } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { escapeHtml, getSafeHrefUrl } from "../messaging/asset-formatting";
import { markdownLinksToHtml, stripMarkdownLinks } from "../messaging/email/html-section";
import { sendUserEmail } from "../messaging/email/index";
import { renderIntradaySparklineImg } from "../messaging/email/intraday-sparkline";
import { buildEmailUrls } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import { createLogoCache, fetchLogoBase64, renderLogoImg } from "../messaging/logo-fetcher";
import { deliveryResultToLogFields, recordNotification } from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { padUrlsToSegmentBoundaries } from "../messaging/sms/segment-utils";
import type { SmsSender } from "../messaging/sms/twilio-utils";
import { shortenUrls } from "../messaging/sms/url-shortener";
import {
	downsampleEvenly,
	EMAIL_SPARKLINE_LABEL,
	SMS_SPARKLINE_LABEL,
	type SparklineWindow,
	toSparkline,
} from "../messaging/sparkline";
import type { EnrichedAlert } from "./enrichment";
import type { PriceAlertUser } from "./users";

/** Cap Grok summary length in SMS to avoid segment/cost spikes from long model output. */
const MAX_SMS_SUMMARY_CHARS = 280;

/** Prepend yesterday's close so the chart's first-to-last delta tracks
 *  the prev-close-anchored "up X% today" headline. Skips the prepend when
 *  prevClose is missing or non-positive (fresh listing / delisted). */
type ChartValues =
	| { values: null }
	| {
			values: number[];
			window: Extract<SparklineWindow, "intraday-since-prev-close" | "intraday-since-open">;
	  };
function buildChartValues(intradayCloses: number[] | null, prevClose: number | null): ChartValues {
	if (!intradayCloses || intradayCloses.length === 0) {
		return { values: null };
	}
	if (prevClose !== null && Number.isFinite(prevClose) && prevClose > 0) {
		return { values: [prevClose, ...intradayCloses], window: "intraday-since-prev-close" };
	}
	return { values: intradayCloses, window: "intraday-since-open" };
}

function formatPriceContextWithSparkline(
	priceContext: string,
	intradayCloses: number[] | null,
	prevClose: number | null,
	downsampleForSms = false,
): string {
	const chart = buildChartValues(intradayCloses, prevClose);
	if (!chart.values) return priceContext;

	const downsampled = downsampleForSms ? downsampleEvenly(chart.values) : chart.values;
	const sparkline = toSparkline(downsampled);
	return sparkline
		? `${priceContext} ${SMS_SPARKLINE_LABEL[chart.window]}: ${sparkline}`
		: priceContext;
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
	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
	const optOutSuffix = "Reply STOP to opt out.";

	const priceContextLine = formatPriceContextWithSparkline(
		alert.priceContext,
		alert.intradayCloses,
		alert.prevClose,
		true,
	);

	const sections = ["StockTextAlerts — Unusual Price Move 🚨", priceContextLine];
	if (alert.signalContext) {
		sections.push(alert.signalContext);
	}

	if (alert.grokResult) {
		const { summary, links } = alert.grokResult;
		// Strip inline markdown links for SMS — URLs are added separately (shortened)
		const smsSummaryText = stripMarkdownLinks(summary, "remove");
		const smsSummary =
			smsSummaryText.length > MAX_SMS_SUMMARY_CHARS
				? `${smsSummaryText.slice(0, MAX_SMS_SUMMARY_CHARS - 1)}…`
				: smsSummaryText;
		const rawUrls = links
			.map((l) => getSafeHrefUrl(l.url))
			.filter((url): url is string => url !== null);
		const urlMap = await shortenUrls(rawUrls, supabase);
		const linkLines = rawUrls.map((url) => urlMap.get(url) ?? url).join("\n");
		sections.push(linkLines ? `${smsSummary}\n${linkLines}` : smsSummary);
	}

	sections.push(`Manage your notifications: ${dashboardUrl}`);
	sections.push(optOutSuffix);

	return padUrlsToSegmentBoundaries(sections.join("\n\n"));
}

function renderHtmlSparklineForAlert(alert: EnrichedAlert, is24: boolean): string {
	const chart = buildChartValues(alert.intradayCloses, alert.prevClose);
	if (!chart.values) return "";
	const sparklineImg = renderIntradaySparklineImg({
		intradayCloses: chart.values,
		is24,
		endTimestampMs: alert.intradayEndTimestamp,
		timestamps: alert.intradayTimestamps,
		// Time axis labels are anchored to today's 9:30 ET open. When we prepend
		// prev close at the leftmost position, those labels become misleading
		// (the line's leftmost point is prev close, not 9:30), so drop them.
		showTimeAxis: chart.window === "intraday-since-open",
	});
	if (!sparklineImg) return "";
	return `
			<p style="color: #92400e; font-size: 12px; margin: 8px 0 0 0;">${EMAIL_SPARKLINE_LABEL[chart.window]}:</p>
			<div style="margin-top: 4px;">${sparklineImg}</div>`;
}

/** Build the "Why it's moving" HTML section for price alert emails. */
function buildWhyMovingHtml(grokResult: EnrichedAlert["grokResult"]): string {
	if (!grokResult) return "";

	// Summary contains inline markdown links from applyAnnotationsInline —
	// convert them to HTML <a> tags the same way the daily digest does.
	const summaryHtml = `
		<div style="margin-top: 16px; padding: 12px 16px; background: #f9fafb; border-radius: 6px; border-left: 3px solid #f59e0b;">
			<p style="color: #4b5563; font-size: 14px; margin: 0; font-style: italic;">${markdownLinksToHtml(grokResult.summary)}</p>
		</div>`;

	return `
		<div style="margin-top: 20px;">
			<h3 style="color: #1f2937; font-size: 16px; font-weight: 600; margin: 0 0 10px 0;">Why it's moving</h3>
			${summaryHtml}
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
		alert.prevClose,
	);

	const textSections = [`Unusual Price Move: ${alert.symbol}`, textPriceContextLine];
	if (alert.signalContext) {
		textSections.push(alert.signalContext);
	}

	if (alert.grokResult) {
		const { summary, links } = alert.grokResult;
		// Strip inline markdown links for plaintext — links are listed separately below
		textSections.push(`Why it's moving:\n${stripMarkdownLinks(summary, "keep-text")}`);
		if (links.length > 0) {
			const linkLines = links
				.map((l) => {
					const via = l.sourceType === "x" ? `via ${l.source} on X` : `via ${l.source}`;
					const safeUrl = getSafeHrefUrl(l.url);
					return `- ${l.title} (${via})${safeUrl ? ` ${safeUrl}` : ""}`;
				})
				.join("\n");
			textSections.push(linkLines);
		}
	}

	textSections.push(`Manage your notifications: ${urls.scheduleUrl}`);
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
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Unusual Price Move</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">${logoHtml ?? ""}${escapeHtml(alert.symbol)}</h2>
		<div style="background: #fffbeb; padding: 16px 20px; border-radius: 6px; margin-bottom: 20px; border: 1px solid #fde68a;">
			<p style="color: #92400e; font-size: 16px; font-weight: 500; margin: 0;">${escapeHtml(alert.priceContext)}</p>${renderHtmlSparklineForAlert(alert, user.use_24_hour_time)}
		</div>
		${
			alert.signalContext
				? `<div style="margin-bottom: 20px;">
			<p style="color: ${alert.benchmarkDirection === "up" ? "#16a34a" : alert.benchmarkDirection === "down" ? "#dc2626" : "#6b7280"}; font-size: 14px; margin: 0;">${escapeHtml(alert.signalContext)}</p>
		</div>`
				: ""
		}
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
	const { user, alert, supabase, sendEmail, sendSms, stats, logoCache } = options;

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
			`${alert.symbol} Unusual ${alert.isPositiveMove ? "Rally" : "Selloff"}`,
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
			rootLogger.info("Price alert SMS skipped: no phone number", {
				userId: user.id,
			});
			stats.smsFailed++;
		} else {
			const smsBody = await formatPriceAlertSms(alert, supabase);
			const result = await sendUserSms(user, smsBody, sendSms, supabase);

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
