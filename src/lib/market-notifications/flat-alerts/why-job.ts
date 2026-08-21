import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../constants";
import { readEnv } from "../../db/env";
import type { Json } from "../../db/generated/database.types";
import type { SupabaseAdminClient } from "../../db/supabase";
import type { Logger } from "../../logging";
import { getIntradayBarsPreferCache } from "../../market-data/price-history-cache";
import { fetchSparklines } from "../../market-data/sparklines";
import { resolveOutboundChannel } from "../../messaging/delivery-channel";
import { attachPrefsToUsers } from "../../messaging/load-prefs";
import { isFacetEnabled } from "../../messaging/notification-prefs";
import { createNotificationSenders } from "../../messaging/senders";
import { loadPersistedAliases } from "../../prediction-markets/alias-enrich";
import type { ChannelDeliveryStats, ExtendedAssetQuote } from "../../types";
import { wakeupAssetBuyerFromFlatAlert, wakeupQuoteFromExtended } from "./asset-buyer-wakeup";
import { deliverFlatPriceAlert } from "./delivery";
import { buildPriceMoveReportUrl } from "./report-url";
import { finalizeFlatPriceAlert, releaseFlatPriceAlert } from "./state";
import type { FlatPriceAlertUser } from "./users";
import type {
	PriceMoveWhyGrade,
	PriceMoveWhyOmitReason,
	PriceMoveWhyVerdict,
	PriorWhyFields,
} from "./why";
import { generatePriceMoveWhyWithGrok } from "./why";
import { claimPriceMoveWhyBudget } from "./why-budget";
import type { PriceMoveWhyMessage } from "./why-queue";

async function persistWhyState(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	symbol: string;
	whyText: string;
	whyVerdict: PriceMoveWhyVerdict;
	whyAt: string;
	whyGrade: PriceMoveWhyGrade | null;
	whyPacket: Record<string, unknown> | null;
	logger: Logger;
}): Promise<boolean> {
	const { supabase, userId, symbol, whyText, whyVerdict, whyAt, whyGrade, whyPacket, logger } =
		options;
	const core = {
		last_why_summary: whyText,
		last_why_verdict: whyVerdict,
		last_why_at: whyAt,
	};
	const extra =
		whyGrade && whyPacket
			? {
					last_why_grade: whyGrade,
					last_why_catalyst_type:
						typeof whyPacket.catalyst_type === "string" ? whyPacket.catalyst_type : null,
					last_why_event_date:
						typeof whyPacket.event_date === "string" ? whyPacket.event_date : null,
					last_why_key_entity:
						typeof whyPacket.key_entity === "string" ? whyPacket.key_entity : null,
					last_why_packet: whyPacket as Json,
				}
			: {};
	const { error } = await supabase
		.from("price_move_alert_state")
		.update({ ...core, ...extra })
		.eq("user_id", userId)
		.eq("symbol", symbol);
	if (error) {
		logger.error("Failed to persist price-move why on state", { userId, symbol }, error);
		return false;
	}
	return Boolean(whyGrade && whyPacket);
}

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
	lambdaWakeup: boolean;
	stats: ChannelDeliveryStats;
};

export async function processPriceMoveWhyAlert(options: {
	supabase: SupabaseAdminClient;
	message: PriceMoveWhyMessage;
	logger: Logger;
}): Promise<PriceMoveWhyJobResult> {
	const { supabase, message, logger } = options;
	const { userId, symbol } = message;

	const extraWhyCols =
		"last_why_grade, last_why_catalyst_type, last_why_event_date, last_why_key_entity";
	const { data: stateRow, error: stateError } = await supabase
		.from("price_move_alert_state")
		.select(`pending_delivery, last_why_summary, last_why_verdict, last_why_at, ${extraWhyCols}`)
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
		return { delivered: false, lambdaWakeup: false, stats: emptyChannelStats() };
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
		return { delivered: false, lambdaWakeup: false, stats: emptyChannelStats() };
	}

	if (user.delivery_channel === "lambda" && !isFacetEnabled(user.prefs, "price_move_alerts")) {
		await releaseFlatPriceAlert(supabase, userId, symbol);
		logger.info("Price-move why job released lambda user: facet off", { userId, symbol });
		return { delivered: false, lambdaWakeup: false, stats: emptyChannelStats() };
	}

	const todayEt = todayEtIso();
	let prior: PriorWhyFields | null = null;
	if (stateRow.last_why_at && todayEt) {
		const whyDay = etIsoDateOf(new Date(stateRow.last_why_at));
		if (whyDay === todayEt && typeof stateRow.last_why_summary === "string") {
			const v = stateRow.last_why_verdict;
			const verdict: PriceMoveWhyVerdict | null =
				v === "same" || v === "updated" || v === "new" || v === "unknown" ? v : null;
			const g = stateRow.last_why_grade;
			const grade: PriceMoveWhyGrade | null =
				g === "confirmed" ||
				g === "reported" ||
				g === "narrative" ||
				g === "sector" ||
				g === "unexplained"
					? g
					: null;
			prior = {
				summary: stateRow.last_why_summary,
				verdict,
				grade,
				catalystType: stateRow.last_why_catalyst_type ?? null,
				eventDate: stateRow.last_why_event_date ?? null,
				keyEntity: stateRow.last_why_key_entity ?? null,
			};
		}
	}

	let persistedAliases: string[] | null = null;
	try {
		const loaded = await loadPersistedAliases(supabase, symbol);
		if (loaded) {
			persistedAliases = loaded.aliases;
			if (loaded.status === "skipped") {
				logger.info("Price-move why: persisted aliases status skipped; using deterministic names", {
					userId,
					symbol,
				});
			}
		}
	} catch (err) {
		logger.warn(
			"Price-move why: persisted alias load failed; continuing with deterministic names",
			{ userId, symbol },
			err,
		);
	}

	let intraday = null;
	try {
		intraday = await getIntradayBarsPreferCache(supabase, symbol);
	} catch (err) {
		logger.warn("Price-move why job: intraday bars unavailable", { userId, symbol }, err);
	}

	const nowUtc = DateTime.utc();
	const xaiAvailable = Boolean(readEnv("XAI_API_KEY_STOCKTEXTALERTS")?.trim());
	let whyText: string | null = null;
	let whyVerdict: PriceMoveWhyVerdict | null = null;
	let whyGrade: PriceMoveWhyGrade | null = null;
	let whyPacket: Record<string, unknown> | null = null;
	let whyUsed = false;
	let omitReason: PriceMoveWhyOmitReason | null = null;

	if (!intraday) {
		omitReason = "bars_failed";
		logger.warn("Price-move why omitted: bars failed", { userId, symbol, reason: omitReason });
	} else if (!xaiAvailable) {
		omitReason = "missing_key";
		logger.warn("Price-move why omitted: XAI unavailable", { userId, symbol, reason: omitReason });
	} else {
		const claimed = await claimPriceMoveWhyBudget(supabase, userId, logger);
		if (!claimed) {
			omitReason = "budget";
			logger.warn("Price-move why omitted: budget exhausted or claim failed", {
				userId,
				symbol,
				reason: omitReason,
			});
		} else {
			const why = await generatePriceMoveWhyWithGrok({
				symbol,
				companyName: message.companyName,
				triggerPercent: message.triggerPercent,
				isAcceleration: message.isAcceleration,
				sessionPercent: message.sessionPercent,
				accelPercent: message.isAcceleration ? message.triggerPercent : null,
				intraday,
				prior,
				persistedAliases,
			});
			if (why.ok) {
				whyText = why.text;
				whyVerdict = why.verdict;
				whyGrade = why.packet.grade;
				whyPacket = why.packet;
				whyUsed = true;
			} else {
				omitReason = why.reason;
				logger.warn("Price-move why omitted", { userId, symbol, reason: omitReason });
			}
		}
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

	if (user.delivery_channel === "lambda") {
		if (!message.session) {
			await releaseFlatPriceAlert(supabase, userId, symbol);
			logger.warn("Price-move why job released lambda user: missing session on why message", {
				userId,
				symbol,
			});
			return { delivered: false, lambdaWakeup: false, stats };
		}
		const woke = await wakeupAssetBuyerFromFlatAlert({
			symbol,
			triggerPercent: message.triggerPercent,
			isAcceleration: message.isAcceleration,
			quote: wakeupQuoteFromExtended(quote),
			session: message.session,
			...(whyPacket ? { catalystPacket: whyPacket } : {}),
		});
		if (!woke) {
			await releaseFlatPriceAlert(supabase, userId, symbol);
			logger.warn("Price-move why job released lambda user: wakeup failed", { userId, symbol });
			return { delivered: false, lambdaWakeup: false, stats };
		}
		await finalizeFlatPriceAlert(supabase, userId, symbol);
		if (whyUsed && whyText !== null && whyVerdict !== null) {
			const whyAt = nowUtc.toISO();
			if (whyAt) {
				await persistWhyState({
					supabase,
					userId,
					symbol,
					whyText,
					whyVerdict,
					whyAt,
					whyGrade,
					whyPacket,
					logger,
				});
			}
		}
		logger.info("Price-move why job lambda wakeup finalized", {
			userId,
			symbol,
			whyUsed,
			whyVerdict,
			omitReason,
			packetAttached: Boolean(whyPacket),
		});
		return { delivered: true, lambdaWakeup: true, stats };
	}

	const { sendEmail, getTelegramSender, logoCache } = createNotificationSenders();
	const sendTelegram =
		resolveOutboundChannel(user) === "telegram" ? getTelegramSender().sender : null;

	// Persist the packet before send so a tap on Full report is not a race.
	let reportUrl: string | null = null;
	if (whyUsed && whyText !== null && whyVerdict !== null) {
		const whyAt = nowUtc.toISO();
		if (whyAt) {
			const packetSaved = await persistWhyState({
				supabase,
				userId,
				symbol,
				whyText,
				whyVerdict,
				whyAt,
				whyGrade,
				whyPacket,
				logger,
			});
			if (packetSaved) {
				reportUrl = buildPriceMoveReportUrl(symbol);
			}
		}
	}

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
		reportUrl,
		catalystPacket: whyPacket,
		...(message.session !== undefined ? { session: message.session } : {}),
	});

	if (delivered) {
		await finalizeFlatPriceAlert(supabase, userId, symbol);
		logger.info("Price-move why job delivered", {
			userId,
			symbol,
			whyUsed,
			whyVerdict,
			omitReason,
			reportLinked: Boolean(reportUrl),
			...stats,
		});
	} else {
		await releaseFlatPriceAlert(supabase, userId, symbol);
		logger.info("Price-move why job released (not delivered)", {
			userId,
			symbol,
			whyUsed,
			omitReason,
			...stats,
		});
	}

	return { delivered, lambdaWakeup: false, stats };
}

/** Inline fallback when SQS enqueue fails or the queue URL is unset. */
export async function runPriceMoveWhyInline(options: {
	supabase: SupabaseAdminClient;
	message: PriceMoveWhyMessage;
	logger: Logger;
}): Promise<PriceMoveWhyJobResult> {
	return processPriceMoveWhyAlert(options);
}
