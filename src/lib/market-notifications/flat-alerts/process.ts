import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../constants";
import type { SupabaseAdminClient } from "../../db/supabase";
import { createLogger } from "../../logging";
import { isFacetEnabled } from "../../messaging/notification-prefs";
import type { ChannelDeliveryStats, ExtendedQuoteMap, MarketSession } from "../../types";
import { wakeupAssetBuyerFromFlatAlert } from "./asset-buyer-wakeup";
import {
	fetchFlatPriceAlertState,
	fetchPriceMoveThresholds,
	finalizeFlatPriceAlert,
	releaseFlatPriceAlert,
	reserveFlatPriceAlert,
	stateKey,
} from "./state";
import { effectivePriceMoveThreshold, priceMoveDirection } from "./threshold";
import type { PriceMoveThreshold } from "./types";
import { type FlatPriceAlertUser, fetchFlatPriceAlertUsers } from "./users";
import { runPriceMoveWhyInline } from "./why-job";
import { enqueuePriceMoveWhy } from "./why-queue";

/** Equity trade window for stock-buyer lambda wakes (matches asset-buyer 04:00–20:00 ET). */
function isEquityTradeSession(session: MarketSession): boolean {
	return session === "pre" || session === "regular" || session === "after";
}

/** Human flat alerts stay RTH-only; lambda (stock-buyer) runs all equity sessions. */
function shouldEvaluateFlatAlertUser(
	user: FlatPriceAlertUser,
	marketSession: MarketSession,
): boolean {
	if (user.delivery_channel === "lambda") {
		return isEquityTradeSession(marketSession);
	}
	return marketSession === "regular";
}

const logger = createLogger({ module: "flat-price-alerts" });

/** Aggregated stats from a flat-price-alert run. */
export interface FlatPriceAlertTotals extends ChannelDeliveryStats {
	usersChecked: number;
	symbolsEvaluated: number;
	alertsTriggered: number;
	claimLost: number;
	firstOfDayAlerts: number;
	reTriggerAlerts: number;
	/** Alerts handed to the price-move why SQS worker (schedule must not deliver). */
	whyEnqueued: number;
	/** Alerts processed inline when enqueue failed / queue URL missing. */
	whyInline: number;
	/** Lambda-channel wakeups (no email/Telegram / no why). */
	lambdaWakeups: number;
}

interface EligibleAlert {
	user: FlatPriceAlertUser;
	symbol: string;
	companyName: string;
	iconUrl: string | null;
	iconBase64: string | null;
	baseline: number;
	triggerPercent: number;
	isReTrigger: boolean;
	isAcceleration: boolean;
	lastNotificationAt: Date | null;
}

function emptyTotals(): FlatPriceAlertTotals {
	return {
		usersChecked: 0,
		symbolsEvaluated: 0,
		alertsTriggered: 0,
		claimLost: 0,
		firstOfDayAlerts: 0,
		reTriggerAlerts: 0,
		whyEnqueued: 0,
		whyInline: 0,
		lambdaWakeups: 0,
		emailsSent: 0,
		emailsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	};
}

/** Compute today's ET calendar date as ISO (YYYY-MM-DD). */
function todayEtIso(): string {
	const iso = DateTime.now().setZone(US_MARKET_TIMEZONE).toISODate();
	if (!iso) {
		throw new Error("Failed to compute today's ET date");
	}
	return iso;
}

/** Compute the ET calendar date of a given Date as ISO (YYYY-MM-DD). */
function etIsoDateOf(date: Date): string {
	const iso = DateTime.fromJSDate(date).setZone(US_MARKET_TIMEZONE).toISODate();
	if (!iso) {
		throw new Error("Failed to compute ET date for input date");
	}
	return iso;
}

/**
 * Process the price-move-alert pipeline: load enabled users and their per-symbol
 * thresholds, compute baselines from cached state vs. prev close, check each
 * asset's configured threshold (percent or dollar), claim eligible alerts
 * atomically, and deliver on the account delivery channel.
 *
 * Reuses the scheduler's captured watched-symbol `quoteMap` (a superset of the
 * threshold symbols) to avoid a duplicate Massive snapshot call.
 *
 * Session gating: email/telegram only during RTH (`regular`); `lambda`
 * (stock-buyer) during the full equity trade session (`pre`/`regular`/`after`).
 */
export async function processFlatPriceAlerts(options: {
	supabase: SupabaseAdminClient;
	quoteMap: ExtendedQuoteMap;
	marketSession: MarketSession;
}): Promise<FlatPriceAlertTotals> {
	const { supabase, quoteMap, marketSession } = options;
	const totals = emptyTotals();

	if (marketSession === "closed") {
		return totals;
	}

	const users = (await fetchFlatPriceAlertUsers(supabase)).filter((u) =>
		shouldEvaluateFlatAlertUser(u, marketSession),
	);
	if (users.length === 0) {
		return totals;
	}
	totals.usersChecked = users.length;

	const userIds = users.map((u) => u.id);

	// Load each user's per-symbol thresholds. Row presence = that asset is opted
	// into price-move alerts; absence = no alert. Replaces the old blanket 5%
	// applied to the whole watchlist.
	const thresholdsByUser = await fetchPriceMoveThresholds(supabase, userIds);
	if (thresholdsByUser.size === 0) {
		return totals;
	}

	// Flatten to (user, threshold) evaluation items, keyed to the loaded users.
	const userMap = new Map<string, FlatPriceAlertUser>();
	for (const user of users) {
		userMap.set(user.id, user);
	}
	const evaluations: { user: FlatPriceAlertUser; threshold: PriceMoveThreshold }[] = [];
	for (const [userId, thresholds] of thresholdsByUser) {
		const user = userMap.get(userId);
		if (!user) continue;
		for (const threshold of thresholds) {
			evaluations.push({ user, threshold });
		}
	}
	if (evaluations.length === 0) {
		return totals;
	}

	const uniqueSymbols = [...new Set(evaluations.map((e) => e.threshold.symbol))];

	// Load asset metadata (name, icon) for display in the email
	const { data: assetRows, error: assetsError } = await supabase
		.from("assets")
		.select("symbol, name, icon_url, icon_base64")
		.in("symbol", uniqueSymbols);

	if (assetsError) {
		logger.error(
			"Failed to load assets metadata for flat price alerts",
			{ symbolCount: uniqueSymbols.length },
			assetsError,
		);
		return totals;
	}

	interface AssetMetadata {
		name: string;
		iconUrl: string | null;
		iconBase64: string | null;
	}
	const assetMetadata = new Map<string, AssetMetadata>();
	for (const row of assetRows ?? []) {
		assetMetadata.set(row.symbol, {
			name: row.name,
			iconUrl: row.icon_url,
			iconBase64: row.icon_base64,
		});
	}

	// Load existing state for all enabled users
	const stateMap = await fetchFlatPriceAlertState(supabase, userIds);

	// Today's ET calendar date (computed once per run, used for staleness checks)
	const todayEt = todayEtIso();

	// Pass 1: compute eligibility and claim slots
	const eligibleAlerts: EligibleAlert[] = [];

	for (const { user, threshold } of evaluations) {
		const symbol = threshold.symbol;
		const quote = quoteMap.get(symbol);
		if (!quote) {
			logger.debug("Skipped: no quote", { userId: user.id, symbol });
			continue;
		}

		totals.symbolsEvaluated++;

		const prevClose = quote.prevClose;
		const stateRow = stateMap.get(stateKey(user.id, symbol));

		// Determine baseline and trigger classification
		let baseline: number;
		let isReTrigger: boolean;
		let lastNotificationAt: Date | null;

		if (stateRow && etIsoDateOf(stateRow.lastNotificationAt) === todayEt) {
			baseline = stateRow.lastNotificationPrice;
			isReTrigger = true;
			lastNotificationAt = stateRow.lastNotificationAt;
		} else {
			if (prevClose === null || prevClose <= 0) {
				logger.info("Skipped: missing prev_close for first-of-day baseline", {
					userId: user.id,
					symbol,
				});
				continue;
			}
			baseline = prevClose;
			isReTrigger = false;
			lastNotificationAt = null;
		}

		// Unit-aware threshold check against the per-stock configured value.
		// Same-direction re-triggers use half (acceleration); reverse moves and
		// first-of-day keep the full value. movePct is always computed for display.
		const movePct = ((quote.price - baseline) / baseline) * 100;
		const moveDollar = quote.price - baseline;
		const moveDirection = priceMoveDirection(quote.price, baseline);
		const { value: effectiveValue, isAcceleration } = effectivePriceMoveThreshold({
			configuredValue: threshold.value,
			isReTrigger,
			lastAlertDirection: stateRow?.lastAlertDirection ?? null,
			moveDirection,
		});
		const meetsThreshold =
			threshold.unit === "percent"
				? Math.abs(movePct) >= effectiveValue
				: Math.abs(moveDollar) >= effectiveValue;
		if (!meetsThreshold) {
			continue;
		}

		// Atomic claim via RPC (handles races across concurrent ticks)
		const claimed = await reserveFlatPriceAlert(supabase, {
			userId: user.id,
			symbol,
			baselinePrice: baseline,
			newPrice: quote.price,
			thresholdValue: effectiveValue,
			thresholdUnit: threshold.unit,
		});
		if (!claimed) {
			totals.claimLost++;
			logger.info("Skipped: claim lost", { userId: user.id, symbol });
			continue;
		}

		const meta = assetMetadata.get(symbol);
		const companyName = meta?.name ?? symbol;
		const iconUrl = meta?.iconUrl ?? null;
		const iconBase64 = meta?.iconBase64 ?? null;

		eligibleAlerts.push({
			user,
			symbol,
			companyName,
			iconUrl,
			iconBase64,
			baseline,
			triggerPercent: movePct,
			isReTrigger,
			isAcceleration,
			lastNotificationAt,
		});

		totals.alertsTriggered++;
		if (isReTrigger) {
			totals.reTriggerAlerts++;
		} else {
			totals.firstOfDayAlerts++;
		}
	}

	if (eligibleAlerts.length === 0) {
		logger.info("Flat price alerts run complete (no alerts)", { ...totals });
		return totals;
	}

	// Fan out to the why worker (one SQS job per user+symbol). On enqueue success the
	// worker owns why + deliver + finalize — schedule must not double-deliver.
	// When the queue URL is missing or send fails, fail-open inline (still try why).
	// Lambda-channel users skip Grok/why entirely: wakeup asset-buyer + finalize.
	for (const alert of eligibleAlerts) {
		const quote = quoteMap.get(alert.symbol);
		if (!quote) continue; // Should never happen given the earlier check, but satisfy TS

		if (alert.user.delivery_channel === "lambda") {
			if (!isFacetEnabled(alert.user.prefs, "price_move_alerts")) {
				await releaseFlatPriceAlert(supabase, alert.user.id, alert.symbol);
				logger.info("Lambda flat alert released: price_move_alerts facet off", {
					userId: alert.user.id,
					symbol: alert.symbol,
				});
				continue;
			}
			const woke = await wakeupAssetBuyerFromFlatAlert({
				symbol: alert.symbol,
				triggerPercent: alert.triggerPercent,
				isAcceleration: alert.isAcceleration,
			});
			if (!woke) {
				await releaseFlatPriceAlert(supabase, alert.user.id, alert.symbol);
				logger.warn("Lambda flat alert released: asset-buyer wakeup failed", {
					userId: alert.user.id,
					symbol: alert.symbol,
				});
				continue;
			}
			await finalizeFlatPriceAlert(supabase, alert.user.id, alert.symbol);
			totals.lambdaWakeups++;
			continue;
		}

		const payload = {
			userId: alert.user.id,
			symbol: alert.symbol,
			companyName: alert.companyName,
			quote: {
				price: quote.price,
				prevClose: quote.prevClose,
				dayOpen: quote.dayOpen,
				changePercent: quote.changePercent,
			},
			baseline: alert.baseline,
			triggerPercent: alert.triggerPercent,
			isReTrigger: alert.isReTrigger,
			isAcceleration: alert.isAcceleration,
			lastNotificationAt: alert.lastNotificationAt ? alert.lastNotificationAt.toISOString() : null,
			iconUrl: alert.iconUrl,
		};

		const enqueued = await enqueuePriceMoveWhy(payload);
		if (enqueued) {
			totals.whyEnqueued++;
			continue;
		}

		totals.whyInline++;
		const inline = await runPriceMoveWhyInline({
			supabase,
			message: { kind: "price-move-why", ...payload },
			logger,
		});
		totals.emailsSent += inline.stats.emailsSent;
		totals.emailsFailed += inline.stats.emailsFailed;
		totals.telegramSent += inline.stats.telegramSent;
		totals.telegramFailed += inline.stats.telegramFailed;
		totals.logFailures += inline.stats.logFailures;
	}

	logger.info("Flat price alerts run complete", { ...totals });
	return totals;
}
