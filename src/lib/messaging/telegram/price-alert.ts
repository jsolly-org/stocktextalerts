import { FormattedString, fmt } from "@grammyjs/parse-mode";
import type { MessageEntity } from "grammy/types";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import type { EnrichedAlert } from "../../price-alerts/types";
import type { ChannelDeliveryStats, IntradayCandle } from "../../types";
import { TELEGRAM_FOOTER } from "../parts/footer";
import { renderPriceAlertHeadline } from "../parts/price-alert-sentences";
import { deliveryResultToLogFields, recordNotification } from "../shared";
import type { TelegramSender } from "../types";
import { buildCandlestickSvg } from "./candlestick";
import { buildDashboardButton } from "./dashboard-button";
import { optOutIfBotBlocked } from "./opt-out";
import { renderChartPng } from "./render-png";

/** Rendered Telegram price alert: entity-formatted caption/text + optional candlestick PNG. */
export interface TelegramPriceAlert {
	text: string;
	entities: MessageEntity[];
	/** Candlestick PNG for `sendPhoto`, or null to send text-only (too few candles / render failed). */
	photo: Buffer | null;
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
	// "AAPL is up 2.5% today ($228.50)" — the same sentence SMS/email produce.
	const boldTicker = FormattedString.bold(`🚨 ${alert.symbol}`);
	let msg = fmt`${boldTicker}\n${renderPriceAlertHeadline(alert.priceMove)}`;

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
 * Tail of the price-move alert pipeline:
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
}): Promise<boolean> {
	const { alert, user, sendTelegram, supabase, stats } = options;

	const { text, entities, photo } = await formatPriceAlertTelegram(
		alert,
		alert.intradayCandles ?? [],
	);
	const result = await sendTelegram({
		// telegram_chat_id is non-null here: every caller gates on isTelegramChannelUsable.
		chatId: user.telegram_chat_id as number,
		text,
		entities,
		// Rides both the candlestick sendPhoto path and the text fallback (sendViaBot
		// forwards reply_markup on both). Price alerts live under Market Notifications.
		replyMarkup: buildDashboardButton("marketNotifications"),
		...(photo ? { photo } : {}),
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
		message: text,
		...deliveryResultToLogFields(result),
	});
	if (!logged) stats.logFailures++;

	return result.success;
}
