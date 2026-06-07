import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../constants";
import { createLogger } from "../../logging";
import { createEmailSender } from "../../messaging/email/utils";
import { createLogoCache } from "../../messaging/logo-fetcher";
import type { SparklineData } from "../../messaging/sparkline";
import { fetchIntradayBars, type IntradayBarsResult } from "../../providers/massive";
import { type ExtendedQuoteMap, fetchSparklines } from "../../providers/price-fetcher";
import type { SupabaseAdminClient } from "../../schedule/helpers";
import { createSmsSenderProvider } from "../../schedule/sms-sender";
import { FLAT_PRICE_ALERT_THRESHOLD_PERCENT } from "./constants";
import { deliverFlatPriceAlert, type FlatPriceAlertDeliveryStats } from "./delivery";
import {
	fetchFlatPriceAlertState,
	finalizeFlatPriceAlert,
	releaseFlatPriceAlert,
	reserveFlatPriceAlert,
	stateKey,
} from "./state";
import { type FlatPriceAlertUser, fetchFlatPriceAlertUsers } from "./users";

const logger = createLogger({ module: "flat-price-alerts" });

/** Aggregated stats from a flat-price-alert run. */
export interface FlatPriceAlertTotals extends FlatPriceAlertDeliveryStats {
	usersChecked: number;
	symbolsEvaluated: number;
	alertsTriggered: number;
	claimLost: number;
	firstOfDayAlerts: number;
	reTriggerAlerts: number;
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
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
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
 * Process the flat-price-alert pipeline: load enabled users, compute baselines
 * from cached state vs. prev close, check the 5% threshold, claim eligible
 * alerts atomically, and deliver emails.
 *
 * Reuses the `quoteMap` already fetched by `processPriceAlerts()` to avoid a
 * duplicate Massive snapshot call. Only runs when the US market is open.
 */
export async function processFlatPriceAlerts(options: {
	supabase: SupabaseAdminClient;
	quoteMap: ExtendedQuoteMap;
	isMarketOpen: boolean;
}): Promise<FlatPriceAlertTotals> {
	const { supabase, quoteMap, isMarketOpen } = options;
	const totals = emptyTotals();

	if (!isMarketOpen) {
		return totals;
	}

	const users = await fetchFlatPriceAlertUsers(supabase);
	if (users.length === 0) {
		return totals;
	}
	totals.usersChecked = users.length;

	const userIds = users.map((u) => u.id);

	// Load tracked assets for enabled users
	const { data: userAssetRows, error: userAssetsError } = await supabase
		.from("user_assets")
		.select("user_id, symbol")
		.in("user_id", userIds);

	if (userAssetsError) {
		logger.error(
			"Failed to load user_assets for flat price alerts",
			{ userCount: userIds.length },
			userAssetsError,
		);
		return totals;
	}

	if (!userAssetRows || userAssetRows.length === 0) {
		return totals;
	}

	const uniqueSymbols = [...new Set(userAssetRows.map((r) => r.symbol))];

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
	const userMap = new Map<string, FlatPriceAlertUser>();
	for (const user of users) {
		userMap.set(user.id, user);
	}

	const eligibleAlerts: EligibleAlert[] = [];

	for (const row of userAssetRows) {
		const user = userMap.get(row.user_id);
		if (!user) continue;

		const symbol = row.symbol;
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

		// Threshold check
		const movePct = ((quote.price - baseline) / baseline) * 100;
		if (Math.abs(movePct) < FLAT_PRICE_ALERT_THRESHOLD_PERCENT) {
			continue;
		}

		// Atomic claim via RPC (handles races across concurrent ticks)
		const claimed = await reserveFlatPriceAlert(supabase, {
			userId: user.id,
			symbol,
			baselinePrice: baseline,
			newPrice: quote.price,
			thresholdPercent: FLAT_PRICE_ALERT_THRESHOLD_PERCENT,
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

	// Batch-fetch sparkline data for triggered symbols (deduped)
	const triggeredSymbols = [...new Set(eligibleAlerts.map((e) => e.symbol))];

	// 7-day sparklines (batched with worker pool inside fetchSparklines)
	let sevenDaySparklines = new Map<string, SparklineData | null>();
	try {
		sevenDaySparklines = await fetchSparklines(triggeredSymbols);
	} catch (err) {
		logger.info(
			"Failed to fetch 7-day sparklines; emails will render without them",
			{ symbolCount: triggeredSymbols.length },
			err,
		);
	}

	// Intraday bars — one call per unique symbol, memoized
	const intradayMap = new Map<string, IntradayBarsResult | null>();
	for (const symbol of triggeredSymbols) {
		try {
			intradayMap.set(symbol, await fetchIntradayBars(symbol));
		} catch (err) {
			logger.info(
				"Failed to fetch intraday bars; email will render without sparkline",
				{ symbol },
				err,
			);
			intradayMap.set(symbol, null);
		}
	}

	// Delivery
	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();
	const anySmsEnabled = eligibleAlerts.some((a) => a.user.price_move_alerts_include_sms);
	const sendSms = anySmsEnabled ? getSmsSender().sender : null;
	const logoCache = createLogoCache();
	const nowMs = Date.now();

	for (const alert of eligibleAlerts) {
		const quote = quoteMap.get(alert.symbol);
		if (!quote) continue; // Should never happen given the earlier check, but satisfy TS

		const delivered = await deliverFlatPriceAlert({
			user: alert.user,
			symbol: alert.symbol,
			companyName: alert.companyName,
			quote,
			baseline: alert.baseline,
			triggerPercent: alert.triggerPercent,
			isReTrigger: alert.isReTrigger,
			lastNotificationAt: alert.lastNotificationAt,
			nowMs,
			todayEt,
			intraday: intradayMap.get(alert.symbol) ?? null,
			sevenDaySparkline: sevenDaySparklines.get(alert.symbol) ?? null,
			iconUrl: alert.iconUrl,
			iconBase64: alert.iconBase64,
			supabase,
			sendEmail,
			sendSms,
			logoCache,
			stats: totals,
		});

		if (delivered) {
			await finalizeFlatPriceAlert(supabase, alert.user.id, alert.symbol);
		} else {
			await releaseFlatPriceAlert(supabase, alert.user.id, alert.symbol);
		}
	}

	logger.info("Flat price alerts run complete", { ...totals });
	return totals;
}
