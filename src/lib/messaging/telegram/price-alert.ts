import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { MessageEntity } from "grammy/types";
import type { EnrichedAlert } from "../../market-notifications/enrichment";
import { buildCandlestickSvg, type Candle, renderChartPng } from "./chart";

/** Rendered Telegram price alert: entity-formatted caption/text + optional candlestick PNG. */
export interface TelegramPriceAlert {
	text: string;
	entities: MessageEntity[];
	/** Candlestick PNG for `sendPhoto`, or null to send text-only (too few candles / render failed). */
	photo: Buffer | null;
}

/**
 * Render an anomaly price-move alert as a Telegram message.
 *
 * Telegram-native: bold ticker, price + signed change%, and a one-line "why it's
 * moving" context when Grok enrichment is present — all carried out-of-band as
 * parse-mode entities (no MarkdownV2/HTML escaping). When ≥2 candles render to a PNG,
 * the caller sends it via `sendPhoto` with this text as the caption; otherwise the
 * text stands alone. Never throws: a render failure or too-few candles degrades to a
 * text-only message rather than dropping the alert.
 *
 * `candles` are the per-bar intraday OHLC bars from the enrichment (`intradayCandles`);
 * `prevClose` from the alert anchors the chart's dashed reference line.
 */
export function formatPriceAlertTelegram(
	alert: EnrichedAlert,
	candles: Candle[],
): TelegramPriceAlert {
	// `priceContext` already reads e.g. "AAPL is up 2.5% today ($228.50)" — reuse it as
	// the human-readable price/change line so SMS/email/Telegram stay consistent.
	const headline = FormattedString.bold(`🚨 ${alert.symbol}`);
	let msg = fmt`${headline}\n${alert.priceContext}`;

	if (alert.signalContext) {
		msg = fmt`${msg}\n${alert.signalContext}`;
	}

	// One-line "why" from Grok, when available. Strip inline markdown links — Telegram
	// renders link text via entities, and the raw summary's `[[label]](url)` markup would
	// otherwise show as literal brackets. We keep just the plain prose for the caption.
	if (alert.grokResult?.summary) {
		const why = alert.grokResult.summary.replace(/\[\[([^\]]+)\]\]\([^)]*\)/g, "$1").trim();
		if (why) {
			msg = fmt`${msg}\n\n${FormattedString.bold("Why it's moving")}\n${FormattedString.blockquote(why)}`;
		}
	}

	let photo: Buffer | null = null;
	if (candles.length >= 2) {
		const svg = buildCandlestickSvg(candles, {
			prevClose: alert.prevClose ?? undefined,
		});
		photo = renderChartPng(svg);
	}

	return { text: msg.text, entities: msg.entities, photo };
}
