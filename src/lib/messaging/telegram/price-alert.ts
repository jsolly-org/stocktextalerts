import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { MessageEntity } from "grammy/types";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import type { EnrichedAlert } from "../../price-alerts/types";
import type { ChannelDeliveryStats, IntradayCandle } from "../../types";
import { buildTelegramPriceFooter } from "../parts/footer";
import { markdownLinksToTelegram } from "../parts/markdown-links";
import { renderPriceAlertHeadline } from "../parts/price-alert-sentences";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { TelegramSender } from "../types";
import { buildCandlestickSvg } from "./candlestick";
import { buildPriceMoveAlertKeyboard } from "./dashboard-button";
import { optOutIfBotBlocked } from "./opt-out";
import { renderChartPng } from "./render-png";

/** Telegram sendPhoto caption limit (UTF-16 code units; JS string length). */
const TELEGRAM_CAPTION_MAX_UTF16 = 1024;
/** Leave a small margin so entity formatting / edge cases do not exceed the cap. */
const TELEGRAM_CAPTION_MARGIN = 16;

/** Rendered Telegram price alert — same discriminant as transport `TelegramMessage`. */
export type TelegramPriceAlert =
	| { kind: "photo"; text: string; entities: MessageEntity[]; photo: Buffer }
	| { kind: "text"; text: string; entities: MessageEntity[] };

/** Truncate plain text to at most `maxLen` UTF-16 code units, appending an ellipsis when cut. */
function truncateUtf16(text: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (text.length <= maxLen) return text;
	if (maxLen <= 1) return "…";
	return `${text.slice(0, maxLen - 1)}…`;
}

function fitWhyForCaption(options: {
	prefix: string;
	why: string;
	footer: string;
	hasPhoto: boolean;
}): string | null {
	const { prefix, why, footer, hasPhoto } = options;
	const whyTrimmed = why.trim();
	if (whyTrimmed === "") return null;

	const withWhy = (whyPart: string) => `${prefix}\n\n${whyPart}\n\n${footer}`;
	if (!hasPhoto) {
		return whyTrimmed;
	}

	const budget =
		TELEGRAM_CAPTION_MAX_UTF16 - TELEGRAM_CAPTION_MARGIN - `${prefix}\n\n\n\n${footer}`.length;
	if (budget < 12) {
		return null;
	}

	const truncated = truncateUtf16(whyTrimmed, budget);
	if (withWhy(truncated).length <= TELEGRAM_CAPTION_MAX_UTF16 - TELEGRAM_CAPTION_MARGIN) {
		return truncated;
	}
	return null;
}

/** Fit a already-rendered why FormattedString into a photo caption budget. */
function fitWhyFormattedForCaption(options: {
	prefix: string;
	why: FormattedString;
	footer: string;
	hasPhoto: boolean;
}): FormattedString | null {
	const fittedText = fitWhyForCaption({
		prefix: options.prefix,
		why: options.why.text,
		footer: options.footer,
		hasPhoto: options.hasPhoto,
	});
	if (fittedText === null) return null;
	if (fittedText === options.why.text) return options.why;

	// Truncated with an ellipsis — slice entities to the kept prefix, then re-append "…".
	const keepLen = fittedText.endsWith("…") ? fittedText.length - 1 : fittedText.length;
	const sliced = options.why.slice(0, keepLen);
	return fittedText.endsWith("…") ? fmt`${sliced}…` : sliced;
}

/**
 * Render a price-move alert as a Telegram message.
 *
 * Telegram-native: bold ticker and price + signed change%, carried out-of-band as
 * parse-mode entities (no MarkdownV2/HTML escaping). When ≥2 candles render to a PNG,
 * the caller sends it via `sendPhoto` with this text as the caption; otherwise the
 * text stands alone. Never throws: a render failure or too-few candles degrades to a
 * text-only message rather than dropping the alert.
 *
 * `candles` are the per-bar intraday OHLC bars from the enrichment (`intradayCandles`);
 * `prevClose` from the alert anchors the chart's dashed reference line.
 */
export async function formatPriceAlertTelegram(
	alert: EnrichedAlert,
	candles: IntradayCandle[],
): Promise<TelegramPriceAlert> {
	// Render this channel's own headline from the structured price facts, e.g.
	// "AAPL is up 2.5% today ($228.50)" — the same sentence the email produces.
	const boldTicker = FormattedString.bold(`🚨 ${alert.symbol}`);
	let msg = fmt`${boldTicker}\n${renderPriceAlertHeadline(alert.priceMove)}`;
	const footer = buildTelegramPriceFooter();

	let photo: Buffer | null = null;
	if (candles.length >= 2) {
		const svg = buildCandlestickSvg(candles, {
			prevClose: alert.prevClose ?? undefined,
		});
		photo = await renderChartPng(svg);
		if (photo === null) {
			// The fixed-input chart:render-png live check can't see input-dependent render
			// failures or a container whose asset cache poisoned on a transient error — this
			// warn is the only breadcrumb for those classes. warn (not error) on purpose: it
			// stays below the { $.level = "error" } alarm filter, preserving degrade-don't-page.
			rootLogger.warn("Chart render degraded to text-only", {
				symbol: alert.symbol,
				candleCount: candles.length,
			});
		}
	}

	// Convert markdown citations before caption fitting so truncation cannot bisect
	// `[[Label]](https://…)` into raw unrendered copy.
	const whyFormatted =
		alert.why && alert.why.trim() !== "" ? markdownLinksToTelegram(alert.why.trim()) : null;
	const whyFit = whyFormatted
		? fitWhyFormattedForCaption({
				prefix: msg.text,
				why: whyFormatted,
				footer,
				hasPhoto: photo !== null,
			})
		: null;
	if (whyFit) {
		msg = fmt`${msg}\n\n${whyFit}`;
	}

	msg = fmt`${msg}\n\n${footer}`;

	// Final safety: if a photo caption still exceeds the hard limit, drop why and rebuild.
	if (photo !== null && msg.text.length > TELEGRAM_CAPTION_MAX_UTF16) {
		const boldTickerRetry = FormattedString.bold(`🚨 ${alert.symbol}`);
		msg = fmt`${boldTickerRetry}\n${renderPriceAlertHeadline(alert.priceMove)}`;
		msg = fmt`${msg}\n\n${footer}`;
	}

	return photo !== null
		? { kind: "photo", text: msg.text, entities: msg.entities, photo }
		: { kind: "text", text: msg.text, entities: msg.entities };
}

/**
 * Send a rendered price alert via Telegram and record the attempt.
 *
 * Tail of the price-move alert pipeline:
 * format → send → stats + failure log → bot-blocked opt-out →
 * notification_log. Callers must gate on channel usability
 * (resolveOutboundChannel / wantsTelegramDelivery) BEFORE calling — the chatId
 * non-null cast relies on that invariant. Returns whether the send succeeded.
 */
export async function deliverTelegramPriceAlert(options: {
	alert: EnrichedAlert;
	user: { id: string; telegram_chat_id: number | null };
	sendTelegram: TelegramSender;
	supabase: AppSupabaseClient;
	stats: ChannelDeliveryStats;
	/** Absolute URL to the auth-gated full report; omit when no packet was saved. */
	fullReportUrl?: string | null;
}): Promise<boolean> {
	const { alert, user, sendTelegram, supabase, stats, fullReportUrl } = options;

	const content = await formatPriceAlertTelegram(alert, alert.intradayCandles ?? []);
	const chatId = user.telegram_chat_id as number;
	const replyMarkup = buildPriceMoveAlertKeyboard(fullReportUrl);
	const result = await sendTelegram({
		...content,
		chatId,
		replyMarkup,
	});

	if (result.success) {
		stats.telegramSent++;
	} else {
		stats.telegramFailed++;
		rootLogger.error(
			"Failed to send price-move alert Telegram message",
			{
				userId: user.id,
				symbol: alert.symbol,
				triggerPercent: alert.priceMove.changePercent,
				errorCode: result.errorCode ?? null,
			},
			new Error(result.error ?? "Price-move alert Telegram send failed"),
		);
	}

	await optOutIfBotBlocked(supabase, user.id, result);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: "flat_price_alert",
		delivery_method: "telegram",
		message_delivered: result.success,
		message: content.text,
		...deliveryResultToLogFields(result),
	});
	if (!logged) stats.logFailures++;

	return result.success;
}
