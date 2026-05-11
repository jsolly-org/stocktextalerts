import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { escapeHtml, getChangeColor } from "../../messaging/asset-formatting";
import { sendUserEmail } from "../../messaging/email/index";
import { renderIntradaySparklineImg } from "../../messaging/email/intraday-sparkline";
import { buildEmailUrls } from "../../messaging/email/layout";
import type { EmailSender } from "../../messaging/email/utils";
import { type createLogoCache, fetchLogoBase64, renderLogoImg } from "../../messaging/logo-fetcher";
import { deliveryResultToLogFields, recordNotification } from "../../messaging/shared";
import { sendUserSms, shouldSendSms } from "../../messaging/sms/index";
import { padUrlsToSegmentBoundaries } from "../../messaging/sms/segment-utils";
import type { SmsSender } from "../../messaging/sms/twilio-utils";
import {
	downsampleEvenly,
	EMAIL_SPARKLINE_LABEL,
	SMS_SPARKLINE_LABEL,
	type SparklineData,
	toSparkline,
} from "../../messaging/sparkline";
import { toSvgSparklineImg } from "../../messaging/svg-sparkline";
import type { IntradayBarsResult } from "../../providers/massive";
import type { ExtendedAssetQuote } from "../../providers/price-fetcher";
import type { FlatPriceAlertUser } from "./users";

/** Per-run delivery counters. */
export interface FlatPriceAlertDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	logFailures: number;
}

/** Unicode-block sparkline cap for SMS. UCS-2 segments fit 70 chars; keep the
 *  sparkline short so it + price rows stay within 1–2 segments. */

/** Format an elapsed duration in minutes/hours as "27 min ago", "1h 23m ago".
 *  Floors to a minimum of "1 min ago" — we never run sub-minute cadence. */
export function formatRelativeMinutesAgo(fromMs: number, toMs: number): string {
	const diffMs = Math.max(0, toMs - fromMs);
	const totalMinutes = Math.max(1, Math.floor(diffMs / 60_000));
	if (totalMinutes < 60) {
		return `${totalMinutes} min ago`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const mins = totalMinutes % 60;
	return `${hours}h ${mins}m ago`;
}

interface PriceChangeRow {
	label: string;
	dollarChange: number;
	percentChange: number;
}

function computeChange(
	from: number,
	to: number,
): {
	dollarChange: number;
	percentChange: number;
} {
	const dollarChange = to - from;
	const percentChange = from > 0 ? (dollarChange / from) * 100 : 0;
	return { dollarChange, percentChange };
}

function formatDollarChange(value: number): string {
	const sign = value >= 0 ? "+" : "−";
	const abs = Math.abs(value).toFixed(2);
	return `${sign}$${abs}`;
}

function formatPercentChange(value: number): string {
	const sign = value >= 0 ? "+" : "−";
	const abs = Math.abs(value).toFixed(2);
	return `${sign}${abs}%`;
}

function formatPriceRowTextLine(row: PriceChangeRow): string {
	const label = row.label.padEnd(32);
	const dollars = formatDollarChange(row.dollarChange).padStart(10);
	const pct = formatPercentChange(row.percentChange).padStart(8);
	return `${label} ${dollars}   ${pct}`;
}

function renderPriceRowHtml(row: PriceChangeRow, extraCell = ""): string {
	const color = getChangeColor(row.percentChange);
	return `
		<tr>
			<td style="padding: 6px 0; color: #374151; font-size: 14px;">${escapeHtml(row.label)}</td>
			<td style="padding: 6px 12px; color: ${color}; font-size: 14px; text-align: right; font-variant-numeric: tabular-nums;">${escapeHtml(formatDollarChange(row.dollarChange))}</td>
			<td style="padding: 6px 0; color: ${color}; font-size: 14px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 500;">${escapeHtml(formatPercentChange(row.percentChange))}</td>
			<td style="padding: 6px 0 6px 12px; text-align: right;">${extraCell}</td>
		</tr>`;
}

function buildPriceChangeRows(options: {
	currentPrice: number;
	prevClose: number | null;
	dayOpen: number | null;
	lastNotificationPrice: number | null;
	sevenDayBaseline: number | null;
	relativeTime: string | null;
}): PriceChangeRow[] {
	const {
		currentPrice,
		prevClose,
		dayOpen,
		lastNotificationPrice,
		sevenDayBaseline,
		relativeTime,
	} = options;

	const rows: PriceChangeRow[] = [];

	if (lastNotificationPrice !== null && relativeTime !== null) {
		const { dollarChange, percentChange } = computeChange(lastNotificationPrice, currentPrice);
		rows.push({
			label: `Since last alert (${relativeTime})`,
			dollarChange,
			percentChange,
		});
	}

	if (dayOpen !== null && dayOpen > 0) {
		const { dollarChange, percentChange } = computeChange(dayOpen, currentPrice);
		rows.push({
			label: "Since today's open",
			dollarChange,
			percentChange,
		});
	}

	if (prevClose !== null && prevClose > 0) {
		const { dollarChange, percentChange } = computeChange(prevClose, currentPrice);
		rows.push({
			label: "Since prev close",
			dollarChange,
			percentChange,
		});
	}

	if (sevenDayBaseline !== null && sevenDayBaseline > 0) {
		const { dollarChange, percentChange } = computeChange(sevenDayBaseline, currentPrice);
		rows.push({
			label: "Past 7 trading days",
			dollarChange,
			percentChange,
		});
	}

	return rows;
}

/** Build the SMS body for a flat price alert. */
function formatFlatPriceAlertSms(options: {
	user: FlatPriceAlertUser;
	symbol: string;
	quote: ExtendedAssetQuote;
	baseline: number;
	triggerPercent: number;
	isReTrigger: boolean;
	lastNotificationAt: Date | null;
	nowMs: number;
	intraday: IntradayBarsResult | null;
	sevenDaySparkline: SparklineData | null;
}): string {
	const {
		symbol,
		quote,
		baseline,
		triggerPercent,
		isReTrigger,
		lastNotificationAt,
		nowMs,
		intraday,
		sevenDaySparkline,
	} = options;

	const currentPrice = quote.price;
	const arrow = triggerPercent >= 0 ? "↑" : "↓";
	const absPct = Math.abs(triggerPercent).toFixed(1);
	const since =
		isReTrigger && lastNotificationAt !== null
			? formatRelativeMinutesAgo(lastNotificationAt.getTime(), nowMs)
			: "today";

	const rows = buildPriceChangeRows({
		currentPrice,
		prevClose: quote.prevClose,
		dayOpen: quote.dayOpen,
		lastNotificationPrice: isReTrigger ? baseline : null,
		sevenDayBaseline:
			sevenDaySparkline && sevenDaySparkline.values.length > 0
				? (sevenDaySparkline.values[0] ?? null)
				: null,
		relativeTime:
			isReTrigger && lastNotificationAt !== null
				? formatRelativeMinutesAgo(lastNotificationAt.getTime(), nowMs)
				: null,
	});

	const intradayCloses = intraday?.closes ?? null;
	const sparkline =
		intradayCloses && intradayCloses.length >= 2
			? toSparkline(downsampleEvenly(intradayCloses))
			: "";

	const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();

	const headline = `${symbol} ${arrow} ${absPct}% ${since} — $${currentPrice.toFixed(2)}`;
	const priceLines = rows.map(
		(row) =>
			`${row.label}: ${formatDollarChange(row.dollarChange)} (${formatPercentChange(row.percentChange)})`,
	);
	const sparklineLine = sparkline
		? `${SMS_SPARKLINE_LABEL["intraday-since-open"]}: ${sparkline}`
		: null;

	const sections = [
		"StockTextAlerts — 5% Price Move 🚨",
		headline,
		...(sparklineLine ? [sparklineLine] : []),
		priceLines.join("\n"),
		`Manage your notifications: ${dashboardUrl}`,
		"Reply STOP to opt out.",
	];

	return padUrlsToSegmentBoundaries(sections.join("\n\n"));
}

function buildSubject(options: {
	symbol: string;
	currentPrice: number;
	triggerPercent: number;
	isReTrigger: boolean;
}): string {
	const { symbol, currentPrice, triggerPercent, isReTrigger } = options;
	const arrow = triggerPercent >= 0 ? "↑" : "↓";
	const absPct = Math.abs(triggerPercent).toFixed(1);
	const suffix = isReTrigger ? "since last alert" : "today";
	return `${symbol} ${arrow} ${absPct}% ${suffix} — $${currentPrice.toFixed(2)}`;
}

/** Build both text and HTML representations of the flat price alert email. */
function formatFlatPriceAlertEmail(options: {
	user: FlatPriceAlertUser;
	symbol: string;
	companyName: string;
	quote: ExtendedAssetQuote;
	baseline: number;
	isReTrigger: boolean;
	lastNotificationAt: Date | null;
	nowMs: number;
	intraday: IntradayBarsResult | null;
	sevenDaySparkline: SparklineData | null;
	logoHtml: string | undefined;
}): { text: string; html: string } {
	const {
		user,
		symbol,
		companyName,
		quote,
		isReTrigger,
		lastNotificationAt,
		nowMs,
		intraday,
		sevenDaySparkline,
		logoHtml,
	} = options;

	const currentPrice = quote.price;
	const prevClose = quote.prevClose;
	const dayOpen = quote.dayOpen;
	const sevenDayBaseline =
		sevenDaySparkline && sevenDaySparkline.values.length > 0
			? (sevenDaySparkline.values[0] ?? null)
			: null;

	const relativeTime =
		isReTrigger && lastNotificationAt !== null
			? formatRelativeMinutesAgo(lastNotificationAt.getTime(), nowMs)
			: null;

	const rows = buildPriceChangeRows({
		currentPrice,
		prevClose,
		dayOpen,
		lastNotificationPrice: isReTrigger ? options.baseline : null,
		sevenDayBaseline,
		relativeTime,
	});

	const urls = buildEmailUrls(user.id, user.email, "marketNotifications");

	// Plain text
	const textLines: string[] = [];
	textLines.push(`Price Move Alert: ${symbol} — ${companyName}`);
	textLines.push("");
	textLines.push(`Current: $${currentPrice.toFixed(2)}`);
	textLines.push("");
	for (const row of rows) {
		textLines.push(formatPriceRowTextLine(row));
	}
	textLines.push("");
	textLines.push(`View Dashboard: ${urls.dashboardUrl}`);
	textLines.push("");
	textLines.push(`Manage alerts: ${urls.scheduleUrl}`);
	textLines.push(`Unsubscribe from all emails: ${urls.unsubscribeUrl}`);
	const text = textLines.join("\n");

	// HTML
	const logoBlock = logoHtml ?? "";

	// 7-day mini sparkline (inline next to "Past 7 trading days" row)
	let sevenDaySparklineHtml = "";
	if (sevenDaySparkline && sevenDaySparkline.values.length >= 2) {
		const firstVal = sevenDaySparkline.values[0];
		const lastVal = sevenDaySparkline.values[sevenDaySparkline.values.length - 1];
		const direction =
			firstVal !== undefined && lastVal !== undefined && firstVal > 0
				? ((lastVal - firstVal) / firstVal) * 100
				: 0;
		const sparkColor = getChangeColor(direction);
		sevenDaySparklineHtml = toSvgSparklineImg(
			sevenDaySparkline.values,
			sparkColor,
			80,
			20,
			"7-day price trend",
		);
	}

	const rowsHtml = rows
		.map((row) => {
			if (row.label === "Past 7 trading days") {
				return renderPriceRowHtml(row, sevenDaySparklineHtml);
			}
			return renderPriceRowHtml(row);
		})
		.join("");

	// Large intraday sparkline (below the table)
	const intradaySvg = renderIntradaySparklineImg({
		intradayCloses: intraday?.closes ?? null,
		is24: user.use_24_hour_time,
		endTimestampMs: intraday?.endTimestamp,
		timestamps: intraday?.timestamps,
	});
	const intradayBlock = intradaySvg
		? `
			<div style="margin-top: 20px;">
				<p style="color: #4b5563; font-size: 12px; margin: 0 0 6px 0;">${EMAIL_SPARKLINE_LABEL["intraday-since-open"]}:</p>
				<div>${intradaySvg}</div>
			</div>`
		: "";

	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%); padding: 28px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 24px; font-weight: 600;">Price Move Alert</h1>
	</div>
	<div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 22px; font-weight: 600; display: flex; align-items: center; gap: 8px;">${logoBlock}<span>${escapeHtml(symbol)} <span style="color: #6b7280; font-size: 16px; font-weight: 400;">— ${escapeHtml(companyName)}</span></span></h2>
		<p style="color: #111827; font-size: 32px; font-weight: 700; margin: 16px 0 12px 0; font-variant-numeric: tabular-nums;">$${escapeHtml(currentPrice.toFixed(2))}</p>
		<table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
			<tbody>${rowsHtml}
			</tbody>
		</table>${intradayBlock}
		<div style="text-align: center; margin-top: 28px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #3b82f6; text-decoration: none; font-size: 14px; font-weight: 500;">View Dashboard →</a>
		</div>
		<p style="color: #6b7280; font-size: 12px; margin-top: 28px; padding-top: 18px; border-top: 1px solid #e5e7eb;">
			<a href="${urls.escapedScheduleUrl}" style="color: #3b82f6; text-decoration: none;">Manage alerts</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${urls.escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from all emails</a>
		</p>
	</div>
</body>
</html>`;

	return { text, html };
}

/** Deliver a flat price alert across the channels the user has enabled
 *  (email and/or SMS) and record each attempt in notification_log. */
export async function deliverFlatPriceAlert(options: {
	user: FlatPriceAlertUser;
	symbol: string;
	companyName: string;
	quote: ExtendedAssetQuote;
	baseline: number;
	triggerPercent: number;
	isReTrigger: boolean;
	lastNotificationAt: Date | null;
	nowMs: number;
	/** Today's ET calendar date as ISO (YYYY-MM-DD). Used to build a stable
	 *  idempotency key on first-of-day alerts so SES dedup catches duplicates
	 *  if the claim RPC fails open mid-run. */
	todayEt: string;
	intraday: IntradayBarsResult | null;
	sevenDaySparkline: SparklineData | null;
	iconUrl: string | null;
	iconBase64: string | null;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	logoCache: ReturnType<typeof createLogoCache>;
	stats: FlatPriceAlertDeliveryStats;
}): Promise<void> {
	const {
		user,
		symbol,
		companyName,
		quote,
		baseline,
		triggerPercent,
		isReTrigger,
		lastNotificationAt,
		nowMs,
		todayEt,
		intraday,
		sevenDaySparkline,
		iconUrl,
		iconBase64,
		supabase,
		sendEmail,
		sendSms,
		logoCache,
		stats,
	} = options;

	// Email
	if (user.price_move_alerts_include_email && user.email_notifications_enabled) {
		const logoDataUri = await fetchLogoBase64(symbol, iconUrl, logoCache, iconBase64, supabase);
		const logoHtml = logoDataUri ? renderLogoImg(logoDataUri) : undefined;

		const message = formatFlatPriceAlertEmail({
			user,
			symbol,
			companyName,
			quote,
			baseline,
			isReTrigger,
			lastNotificationAt,
			nowMs,
			intraday,
			sevenDaySparkline,
			logoHtml,
		});

		const subject = buildSubject({
			symbol,
			currentPrice: quote.price,
			triggerPercent,
			isReTrigger,
		});

		// Re-trigger keys off last_notification_at (stable until the next alert
		// fires). First-of-day keys off the ET calendar date (stable across all
		// cron ticks of the day), so if the claim RPC fails open and the email
		// send fires again on the next tick, SES dedup collapses it to one send.
		const idempotencyKey = lastNotificationAt
			? `flat-price-alert-${user.id}-${symbol}-${lastNotificationAt.toISOString()}`
			: `flat-price-alert-${user.id}-${symbol}-first-${todayEt}`;

		const result = await sendUserEmail(user, subject, message, sendEmail, idempotencyKey);

		if (result.success) {
			stats.emailsSent++;
		} else {
			stats.emailsFailed++;
			rootLogger.error(
				"Failed to send flat price alert email",
				{ userId: user.id, symbol, triggerPercent, isReTrigger },
				result.error,
			);
		}

		const logged = await recordNotification(supabase, {
			user_id: user.id,
			type: "flat_price_alert",
			delivery_method: "email",
			message_delivered: result.success,
			message: message.text,
			...deliveryResultToLogFields(result),
		});
		if (!logged) stats.logFailures++;
	}

	// SMS
	if (user.price_move_alerts_include_sms && sendSms) {
		if (!shouldSendSms(user)) {
			rootLogger.info("Flat price alert SMS skipped: user not eligible", {
				userId: user.id,
				symbol,
			});
			stats.smsFailed++;
		} else {
			const smsBody = formatFlatPriceAlertSms({
				user,
				symbol,
				quote,
				baseline,
				triggerPercent,
				isReTrigger,
				lastNotificationAt,
				nowMs,
				intraday,
				sevenDaySparkline,
			});
			const result = await sendUserSms(user, smsBody, sendSms, supabase);

			if (result.success) {
				stats.smsSent++;
			} else {
				stats.smsFailed++;
				rootLogger.error(
					"Failed to send flat price alert SMS",
					{ userId: user.id, symbol, triggerPercent, isReTrigger },
					result.error,
				);
			}

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "flat_price_alert",
				delivery_method: "sms",
				message_delivered: result.success,
				message: smsBody,
				...deliveryResultToLogFields(result),
			});
			if (!logged) stats.logFailures++;
		}
	}
}
