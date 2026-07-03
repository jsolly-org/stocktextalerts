import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { MessageEntity } from "grammy/types";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import type { EnrichedAlert } from "../../price-alerts/types";
import type { ChannelDeliveryStats, IntradayCandle } from "../../types";
import { buildCandlestickSvg } from "../parts/charts/candlestick";
import { renderChartPng } from "../parts/charts/render-png";
import { TELEGRAM_FOOTER } from "../parts/footer";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { TelegramSender } from "../types";
import { optOutIfBotBlocked } from "./opt-out";

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
export async function formatPriceAlertTelegram(
	alert: EnrichedAlert,
	candles: IntradayCandle[],
): Promise<TelegramPriceAlert> {
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

	msg = fmt`${msg}\n\n${TELEGRAM_FOOTER}`;

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

	return { text: msg.text, entities: msg.entities, photo };
}

/**
 * Send a rendered price alert via Telegram and record the attempt.
 *
 * Shared tail of the real-time alert pipelines (anomaly, flat):
 * format → send → stats + failure log → bot-blocked opt-out →
 * notification_log. Callers must gate on channel usability
 * (isTelegramChannelUsable / shouldSendTelegram) BEFORE calling — the chatId
 * non-null cast relies on that invariant. Returns whether the send succeeded.
 */
export async function deliverTelegramPriceAlert(options: {
	alert: EnrichedAlert;
	user: { id: string; telegram_chat_id: number | null };
	sendTelegram: TelegramSender;
	supabase: AppSupabaseClient;
	stats: ChannelDeliveryStats;
	notificationType: "price_alert" | "flat_price_alert";
	failureLogMessage: string;
	failureErrorFallback: string;
	failureLogContext: Record<string, unknown>;
}): Promise<boolean> {
	const { alert, user, sendTelegram, supabase, stats, notificationType } = options;

	const { text, entities, photo } = await formatPriceAlertTelegram(
		alert,
		alert.intradayCandles ?? [],
	);
	const result = await sendTelegram({
		// telegram_chat_id is non-null here: every caller gates on isTelegramChannelUsable.
		chatId: user.telegram_chat_id as number,
		text,
		entities,
		...(photo ? { photo } : {}),
	});

	if (result.success) {
		stats.telegramSent++;
	} else {
		stats.telegramFailed++;
		rootLogger.error(
			options.failureLogMessage,
			{ userId: user.id, ...options.failureLogContext, errorCode: result.errorCode ?? null },
			new Error(result.error ?? options.failureErrorFallback),
		);
	}

	await optOutIfBotBlocked(supabase, user.id, result);

	const logged = await recordNotification(supabase, {
		user_id: user.id,
		type: notificationType,
		delivery_method: "telegram",
		message_delivered: result.success,
		message: text,
		...deliveryResultToLogFields(result),
	});
	if (!logged) stats.logFailures++;

	return result.success;
}
