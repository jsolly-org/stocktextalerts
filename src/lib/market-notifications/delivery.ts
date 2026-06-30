import { getSiteUrl } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { isEmailChannelUsable } from "../messaging/email/eligibility";
import { markdownLinksToHtml, stripMarkdownLinks } from "../messaging/email/html-section";
import { sendUserEmail } from "../messaging/email/index";
import { buildEmailUrls, renderEmailFooter, renderEmailShell } from "../messaging/email/layout";
import type { EmailSender } from "../messaging/email/utils";
import { createLogoCache, fetchLogoBase64, renderLogoImg } from "../messaging/logo-fetcher";
import { isFacetEnabled } from "../messaging/notification-prefs";
import { renderIntradaySparklineImg } from "../messaging/parts/charts/intraday-sparkline";
import {
	downsampleEvenly,
	EMAIL_SPARKLINE_LABEL,
	SMS_SPARKLINE_LABEL,
	type SparklineWindow,
	toSparkline,
} from "../messaging/parts/charts/sparkline";
import { NOT_FINANCIAL_ADVICE, SMS_OPT_OUT } from "../messaging/parts/footer";
import { escapeHtml, getSafeHrefUrl } from "../messaging/parts/html-utils";
import { deliveryResultToLogFields, recordNotification } from "../messaging/shared";
import { sendUserSms, shouldSendSms } from "../messaging/sms/index";
import { padUrlsToSegmentBoundaries } from "../messaging/sms/segment-utils";
import type { SmsSender } from "../messaging/sms/twilio-utils";
import { shortenUrls } from "../messaging/sms/url-shortener";
import { isTelegramChannelUsable, shouldSendTelegram } from "../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../messaging/telegram/opt-out";
import { formatPriceAlertTelegram } from "../messaging/telegram/price-alert";
import type { TelegramSender } from "../messaging/telegram/sender";
import type { EnrichedAlert } from "../price-alerts/types";
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

/** Per-run delivery counters for price alerts (email/SMS/Telegram success/fail and log failures). */
export interface PriceAlertDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	telegramSent: number;
	telegramFailed: number;
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
	const optOutSuffix = SMS_OPT_OUT;

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
	sections.push(NOT_FINANCIAL_ADVICE);

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
	textSections.push(NOT_FINANCIAL_ADVICE);

	const text = textSections.join("\n\n");

	// HTML

	const whyMovingHtml = buildWhyMovingHtml(alert.grokResult);

	const html = renderEmailShell({
		bodyHtml: `<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Unusual Price Move: ${logoHtml ?? ""}${escapeHtml(alert.symbol)}</h2>
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
		</div>`,
		footerHtml: renderEmailFooter(urls),
	});

	return { text, html };
}

/**
 * Deliver a price alert to a user via their preferred channels.
 * @returns true when at least one enabled channel delivered successfully.
 */
export async function deliverPriceAlert(options: {
	user: PriceAlertUser;
	alert: EnrichedAlert;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	/** Telegram sender, threaded the same way as `sendSms` (lazy provider in process.ts). */
	sendTelegram?: TelegramSender | null;
	stats: PriceAlertDeliveryStats;
	logoCache?: ReturnType<typeof createLogoCache>;
}): Promise<boolean> {
	const { user, alert, supabase, sendEmail, sendSms, sendTelegram, stats, logoCache } = options;
	let delivered = false;

	// Email delivery — gate on the global email kill-switch AND the per-option facet,
	// matching every sibling notification type (the facet alone does not imply the global flag).
	if (
		isEmailChannelUsable(user) &&
		isFacetEnabled(user.prefs, "market_asset_price_alerts", "email")
	) {
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
			delivered = true;
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
	if (isFacetEnabled(user.prefs, "market_asset_price_alerts", "sms") && sendSms) {
		// Channel ineligibility (opted out / unverified / no phone) is a config skip, NOT a
		// delivery failure — leave it uncounted, matching the scheduled paths and price
		// targets, so smsFailed reflects real send failures only.
		if (!shouldSendSms(user)) {
			rootLogger.info("Price alert SMS skipped: user not eligible", {
				userId: user.id,
			});
		} else if (!user.phone_country_code || !user.phone_number) {
			rootLogger.info("Price alert SMS skipped: no phone number", {
				userId: user.id,
			});
		} else {
			const smsBody = await formatPriceAlertSms(alert, supabase);
			const result = await sendUserSms(user, smsBody, sendSms, supabase);

			if (result.success) {
				stats.smsSent++;
				delivered = true;
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

	// Telegram delivery (additive; never alters the email/SMS paths above). This is the
	// real-time anomaly alert — no claim RPC; the alert-level cooldown that gated email/SMS
	// already deduped this symbol×user, so Telegram piggybacks with no extra idempotency.
	// Only query per-option prefs for users whose channel is usable (linked + not opted out),
	// skipping the lookup for the majority who never linked Telegram.
	if (sendTelegram && isTelegramChannelUsable(user)) {
		if (shouldSendTelegram(user, user.prefs, "market_asset_price_alerts")) {
			const { text, entities, photo } = formatPriceAlertTelegram(
				alert,
				alert.intradayCandles ?? [],
			);
			const result = await sendTelegram({
				// telegram_chat_id is non-null here: isTelegramChannelUsable requires it.
				chatId: user.telegram_chat_id as number,
				text,
				entities,
				...(photo ? { photo } : {}),
			});

			if (result.success) {
				stats.telegramSent++;
				delivered = true;
			} else {
				stats.telegramFailed++;
				rootLogger.error(
					"Failed to send price alert Telegram message",
					{ userId: user.id, symbol: alert.symbol, errorCode: result.errorCode ?? null },
					new Error(result.error ?? "Price alert Telegram send failed"),
				);
			}

			await optOutIfBotBlocked(supabase, user.id, result);

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "price_alert",
				delivery_method: "telegram",
				message_delivered: result.success,
				message: text,
				...deliveryResultToLogFields(result),
			});
			if (!logged) stats.logFailures++;
		}
	}

	return delivered;
}
