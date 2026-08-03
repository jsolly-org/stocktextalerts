import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../constants";
import { readEnv } from "../../db/env";
import type { SupabaseAdminClient } from "../../db/supabase";
import type { Logger } from "../../logging";
import { getIntradayBarsPreferCache } from "../../market-data/price-history-cache";
import { fetchSparklines } from "../../market-data/sparklines";
import { resolveOutboundChannel } from "../../messaging/delivery-channel";
import { attachPrefsToUsers } from "../../messaging/load-prefs";
import { createNotificationSenders } from "../../messaging/senders";
import type { ChannelDeliveryStats, ExtendedAssetQuote } from "../../types";
import { deliverFlatPriceAlert } from "./delivery";
import { finalizeFlatPriceAlert, releaseFlatPriceAlert } from "./state";
import type { FlatPriceAlertUser } from "./users";
import type { PriceMoveWhyVerdict } from "./why";
import { generatePriceMoveWhyWithGrok } from "./why";
import { claimPriceMoveWhyBudget } from "./why-budget";
import type { PriceMoveWhyMessage } from "./why-queue";

function emptyChannelStats(): ChannelDeliveryStats {
	return {
		emailsSent: 0,
		emailsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	};
}

function etIsoDateOf(date: Date): string | null {
	return DateTime.fromJSDate(date).setZone(US_MARKET_TIMEZONE).toISODate();
}

function todayEtIso(): string | null {
	return DateTime.now().setZone(US_MARKET_TIMEZONE).toISODate();
}

function toExtendedQuote(message: PriceMoveWhyMessage): ExtendedAssetQuote {
	const { quote } = message;
	return {
		price: quote.price,
		changePercent: quote.changePercent ?? message.triggerPercent,
		prevClose: quote.prevClose,
		dayOpen: quote.dayOpen ?? null,
		dayHigh: null,
		dayLow: null,
		timestamp: null,
		volume: null,
	};
}

async function loadFlatPriceAlertUser(
	supabase: SupabaseAdminClient,
	userId: string,
	logger: Logger,
): Promise<FlatPriceAlertUser | null> {
	const { data, error } = await supabase
		.from("users")
		.select(
			"id, email, delivery_channel, use_24_hour_time, telegram_chat_id, price_move_why_window_start, price_move_why_sends_in_window",
		)
		.eq("id", userId)
		.maybeSingle();

	if (error) {
		logger.error("Failed to load user for price-move why job", { userId }, error);
		throw new Error(`loadFlatPriceAlertUser failed: ${error.message}`);
	}
	if (!data) {
		logger.info("Price-move why job: user not found", { userId });
		return null;
	}

	const [withPrefs] = await attachPrefsToUsers(supabase, [data]);
	return withPrefs ?? null;
}

/**
 * Core worker: optional Grok why → deliver flat price alert → finalize/release.
 * Fail-open on Grok: always attempt delivery. Idempotent when reservation is gone.
 */
export type PriceMoveWhyJobResult = {
	delivered: boolean;
	stats: ChannelDeliveryStats;
};

export async function processPriceMoveWhyAlert(options: {
	supabase: SupabaseAdminClient;
	message: PriceMoveWhyMessage;
	logger: Logger;
}): Promise<PriceMoveWhyJobResult> {
	const { supabase, message, logger } = options;
	const { userId, symbol } = message;

	const { data: stateRow, error: stateError } = await supabase
		.from("price_move_alert_state")
		.select("pending_delivery, last_why_summary, last_why_verdict, last_why_at")
		.eq("user_id", userId)
		.eq("symbol", symbol)
		.maybeSingle();

	if (stateError) {
		logger.error(
			"Failed to load price_move_alert_state for why job",
			{ userId, symbol },
			stateError,
		);
		throw new Error(`price_move_alert_state select failed: ${stateError.message}`);
	}

	if (!stateRow?.pending_delivery) {
		logger.info("Price-move why job no-op: reservation not pending", { userId, symbol });
		return { delivered: false, stats: emptyChannelStats() };
	}

	// Refresh reservation clock so SQS retries stay inside the pending TTL.
	const { error: touchError } = await supabase
		.from("price_move_alert_state")
		.update({ reserved_at: new Date().toISOString() })
		.eq("user_id", userId)
		.eq("symbol", symbol)
		.eq("pending_delivery", true);
	if (touchError) {
		logger.warn("Failed to refresh reserved_at for why job", { userId, symbol }, touchError);
	}

	const user = await loadFlatPriceAlertUser(supabase, userId, logger);
	if (!user) {
		await releaseFlatPriceAlert(supabase, userId, symbol);
		return { delivered: false, stats: emptyChannelStats() };
	}

	const todayEt = todayEtIso();
	let priorWhySummary: string | null = null;
	let priorWhyVerdict: PriceMoveWhyVerdict | null = null;
	if (stateRow.last_why_at && todayEt) {
		const whyDay = etIsoDateOf(new Date(stateRow.last_why_at));
		if (whyDay === todayEt && typeof stateRow.last_why_summary === "string") {
			priorWhySummary = stateRow.last_why_summary;
			const v = stateRow.last_why_verdict;
			if (v === "same" || v === "updated" || v === "new" || v === "unknown") {
				priorWhyVerdict = v;
			}
		}
	}

	const nowUtc = DateTime.utc();
	const xaiAvailable = Boolean(readEnv("XAI_API_KEY")?.trim());
	let whyText: string | null = null;
	let whyVerdict: PriceMoveWhyVerdict | null = null;
	let whyUsed = false;

	if (xaiAvailable) {
		const claimed = await claimPriceMoveWhyBudget(supabase, userId, logger);
		if (claimed) {
			const why = await generatePriceMoveWhyWithGrok({
				symbol,
				companyName: message.companyName,
				triggerPercent: message.triggerPercent,
				isAcceleration: message.isAcceleration,
				priorWhySummary,
				priorWhyVerdict,
			});
			if (why) {
				whyText = why.text;
				whyVerdict = why.verdict;
				whyUsed = true;
			}
		} else {
			logger.info("Price-move why skipped: budget exhausted or claim failed", {
				userId,
				symbol,
			});
		}
	} else {
		logger.info("Price-move why skipped: XAI unavailable", { userId, symbol });
	}

	let intraday = null;
	try {
		intraday = await getIntradayBarsPreferCache(supabase, symbol);
	} catch (err) {
		logger.info("Price-move why job: intraday bars unavailable", { userId, symbol }, err);
	}

	let sevenDaySparkline = null;
	try {
		const map = await fetchSparklines([symbol]);
		sevenDaySparkline = map.get(symbol) ?? null;
	} catch (err) {
		logger.info("Price-move why job: 7-day sparkline unavailable", { userId, symbol }, err);
	}

	const quote = toExtendedQuote(message);
	const lastNotificationAt = message.lastNotificationAt
		? new Date(message.lastNotificationAt)
		: null;
	const stats = emptyChannelStats();
	const { sendEmail, getTelegramSender, logoCache } = createNotificationSenders();
	const sendTelegram =
		resolveOutboundChannel(user) === "telegram" ? getTelegramSender().sender : null;

	const delivered = await deliverFlatPriceAlert({
		user,
		symbol,
		companyName: message.companyName,
		quote,
		baseline: message.baseline,
		triggerPercent: message.triggerPercent,
		isReTrigger: message.isReTrigger,
		isAcceleration: message.isAcceleration,
		lastNotificationAt,
		nowMs: Date.now(),
		intraday,
		sevenDaySparkline,
		iconUrl: message.iconUrl,
		iconBase64: null,
		supabase,
		sendEmail,
		sendTelegram,
		logoCache,
		stats,
		whyText,
	});

	if (delivered) {
		await finalizeFlatPriceAlert(supabase, userId, symbol);
		if (whyUsed && whyText !== null && whyVerdict !== null) {
			const whyAt = nowUtc.toISO();
			const { error: whyPersistError } = await supabase
				.from("price_move_alert_state")
				.update({
					last_why_summary: whyText,
					last_why_verdict: whyVerdict,
					last_why_at: whyAt,
				})
				.eq("user_id", userId)
				.eq("symbol", symbol);
			if (whyPersistError) {
				logger.error(
					"Failed to persist price-move why on state",
					{ userId, symbol },
					whyPersistError,
				);
			}
		}
		logger.info("Price-move why job delivered", {
			userId,
			symbol,
			whyUsed,
			whyVerdict,
			...stats,
		});
	} else {
		await releaseFlatPriceAlert(supabase, userId, symbol);
		logger.info("Price-move why job released (not delivered)", {
			userId,
			symbol,
			whyUsed,
			...stats,
		});
	}

	return { delivered, stats };
}

/** Inline fallback when SQS enqueue fails or the queue URL is unset. */
export async function runPriceMoveWhyInline(options: {
	supabase: SupabaseAdminClient;
	message: PriceMoveWhyMessage;
	logger: Logger;
}): Promise<PriceMoveWhyJobResult> {
	return processPriceMoveWhyAlert(options);
}
