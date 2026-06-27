import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import type { ExtendedAssetQuote } from "../../market-data/types";
import { escapeHtml, formatUsdPrice, getChangeColor } from "../../messaging/asset-formatting";
import { sendUserEmail } from "../../messaging/email/index";
import { renderIntradaySparklineImg } from "../../messaging/email/intraday-sparkline";
import { buildEmailUrls, renderEmailFooter, renderEmailShell } from "../../messaging/email/layout";
import type { EmailSender } from "../../messaging/email/utils";
import { NOT_FINANCIAL_ADVICE, SMS_OPT_OUT } from "../../messaging/footer";
import { type createLogoCache, fetchLogoBase64, renderLogoImg } from "../../messaging/logo-fetcher";
import { isFacetEnabled } from "../../messaging/notification-prefs";
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
import { isTelegramChannelUsable, shouldSendTelegram } from "../../messaging/telegram/eligibility";
import { optOutIfBotBlocked } from "../../messaging/telegram/opt-out";
import { formatPriceAlertTelegram } from "../../messaging/telegram/price-alert";
import type { TelegramSender } from "../../messaging/telegram/sender";
import type { IntradayBarsResult } from "../../vendors/massive/aggregates";
import type { EnrichedAlert } from "../enrichment";
import type { FlatPriceAlertUser } from "./users";

/** Per-run delivery counters. */
export interface FlatPriceAlertDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	telegramSent: number;
	telegramFailed: number;
	logFailures: number;
}

/**
 * Build a minimal `EnrichedAlert` from flat-price-alert data so the shared
 * `formatPriceAlertTelegram` renderer (bold ticker + price line + optional
 * candlestick chart) can be reused. Flat alerts carry no Grok/anomaly context,
 * so `signalContext`/`grokResult` are empty.
 */
function buildFlatAlertEnriched(options: {
	symbol: string;
	quote: ExtendedAssetQuote;
	triggerPercent: number;
	since: string;
	intraday: IntradayBarsResult | null;
}): EnrichedAlert {
	const { symbol, quote, triggerPercent, since, intraday } = options;
	const direction = triggerPercent >= 0 ? "up" : "down";
	const absPct = Math.abs(triggerPercent).toFixed(1);
	return {
		symbol,
		priceContext: `${symbol} is ${direction} ${absPct}% ${since} (${formatUsdPrice(quote.price)})`,
		signalContext: "",
		grokContext: "",
		grokResult: null,
		intradayCloses: intraday?.closes ?? null,
		intradayTimestamps: intraday?.timestamps ?? null,
		intradayEndTimestamp: intraday?.endTimestamp ?? null,
		intradayCandles: intraday?.candles ?? null,
		prevClose: quote.prevClose,
		isPositiveMove: triggerPercent >= 0,
	};
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

	const headline = `${symbol} ${arrow} ${absPct}% ${since} — ${formatUsdPrice(currentPrice)}`;
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
		SMS_OPT_OUT,
		NOT_FINANCIAL_ADVICE,
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
	// Alert SUBJECT rounds change% to 1 decimal for readability — deliberately coarser
	// than the 2-decimal precision on multi-asset price lines (asset-formatting.ts), mirroring
	// the price-alert headline (enrichment.ts buildPriceContext).
	const absPct = Math.abs(triggerPercent).toFixed(1);
	const suffix = isReTrigger ? "since last alert" : "today";
	return `${symbol} ${arrow} ${absPct}% ${suffix} — ${formatUsdPrice(currentPrice)}`;
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
	textLines.push(`Current: ${formatUsdPrice(currentPrice)}`);
	textLines.push("");
	for (const row of rows) {
		textLines.push(formatPriceRowTextLine(row));
	}
	textLines.push("");
	textLines.push(`View Dashboard: ${urls.dashboardUrl}`);
	textLines.push("");
	textLines.push(`Manage alerts: ${urls.scheduleUrl}`);
	textLines.push(`Unsubscribe from all emails: ${urls.unsubscribeUrl}`);
	textLines.push(NOT_FINANCIAL_ADVICE);
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

	const html = renderEmailShell({
		bodyHtml: `<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600; display: flex; align-items: center; gap: 8px;">Price Move Alert: ${logoBlock}<span>${escapeHtml(symbol)} <span style="color: #6b7280; font-size: 16px; font-weight: 400;">— ${escapeHtml(companyName)}</span></span></h2>
		<p style="color: #111827; font-size: 32px; font-weight: 700; margin: 16px 0 12px 0; font-variant-numeric: tabular-nums;">${escapeHtml(formatUsdPrice(currentPrice))}</p>
		<table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
			<tbody>${rowsHtml}
			</tbody>
		</table>${intradayBlock}
		<div style="text-align: center; margin-top: 28px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">View Dashboard →</a>
		</div>`,
		footerHtml: renderEmailFooter(urls),
	});

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
	intraday: IntradayBarsResult | null;
	sevenDaySparkline: SparklineData | null;
	iconUrl: string | null;
	iconBase64: string | null;
	supabase: AppSupabaseClient;
	sendEmail: EmailSender;
	sendSms: SmsSender | null;
	/** Telegram sender, threaded the same way as `sendSms` (lazy provider in process.ts). */
	sendTelegram?: TelegramSender | null;
	logoCache: ReturnType<typeof createLogoCache>;
	stats: FlatPriceAlertDeliveryStats;
}): Promise<boolean> {
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
		intraday,
		sevenDaySparkline,
		iconUrl,
		iconBase64,
		supabase,
		sendEmail,
		sendSms,
		sendTelegram,
		logoCache,
		stats,
	} = options;

	let delivered = false;

	// Email
	if (
		isFacetEnabled(user.prefs, "price_move_alerts", "email") &&
		user.email_notifications_enabled
	) {
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

		// Dedup is the flat-alert reserve/finalize CAS (reserve_flat_price_alert), not an
		// email-level key: the direct-SES path does not honor idempotency keys, so a
		// claim that fails open CAN double-send. The reserve CAS is the real guard.
		const result = await sendUserEmail(user, subject, message, sendEmail);

		if (result.success) {
			stats.emailsSent++;
			delivered = true;
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
	if (isFacetEnabled(user.prefs, "price_move_alerts", "sms") && sendSms) {
		if (!shouldSendSms(user)) {
			// Channel ineligibility is a config skip, NOT a delivery failure — leave it
			// uncounted, matching the scheduled paths and price targets.
			rootLogger.info("Flat price alert SMS skipped: user not eligible", {
				userId: user.id,
				symbol,
			});
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
				delivered = true;
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

	// Telegram delivery (additive; never alters the email/SMS paths above). Real-time
	// alert — no claim RPC; the per-symbol flat-alert reservation already deduped this
	// symbol×user, so Telegram piggybacks. Only query per-option prefs for users whose
	// channel is usable (linked + not opted out).
	if (sendTelegram && isTelegramChannelUsable(user)) {
		if (shouldSendTelegram(user, user.prefs, "price_move_alerts")) {
			const since =
				isReTrigger && lastNotificationAt !== null
					? formatRelativeMinutesAgo(lastNotificationAt.getTime(), nowMs)
					: "today";
			const enriched = buildFlatAlertEnriched({ symbol, quote, triggerPercent, since, intraday });
			const { text, entities, photo } = formatPriceAlertTelegram(
				enriched,
				enriched.intradayCandles ?? [],
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
					"Failed to send flat price alert Telegram message",
					{ userId: user.id, symbol, triggerPercent, errorCode: result.errorCode ?? null },
					new Error(result.error ?? "Flat price alert Telegram send failed"),
				);
			}

			await optOutIfBotBlocked(supabase, user.id, result);

			const logged = await recordNotification(supabase, {
				user_id: user.id,
				type: "flat_price_alert",
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
