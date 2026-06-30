import { DateTime } from "luxon";
import { SECTOR_ETF_MAP } from "../assets/constants";
import {
	US_MARKET_CLOSE_EASTERN_MINUTES,
	US_MARKET_OPEN_EASTERN_MINUTES,
	US_MARKET_TIMEZONE,
} from "../constants";
import type { SupabaseAdminClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { fetchIntradayBars } from "../market-data/bars";
import { fetchExtendedQuotes } from "../market-data/prices";
import { getCurrentMarketSession } from "../market-data/session";
import { isFacetEnabled } from "../messaging/notification-prefs";
import { createNotificationSenders } from "../messaging/runtime/senders";
import { isTelegramChannelUsable } from "../messaging/telegram/eligibility";
import type { EnrichedAlert } from "../price-alerts/types";
import type { ExtendedAssetQuote, ExtendedQuoteMap, IntradayCandle, MarketSession } from "../types";
import { getAnomalyThreshold } from "./alert-profile";
import { computeAnomalyScore } from "./anomaly-detection";
import { fetchDailyStats } from "./daily-stats";
import { deliverPriceAlert, type PriceAlertDeliveryStats } from "./delivery";
import { enrichAlert } from "./enrichment";
import { getSnapshotsForSymbols, storeSnapshots } from "./snapshot-store";
import {
	fetchPriceAlertUsers,
	finalizeCooldownSlot,
	releaseCooldownSlot,
	reserveCooldownSlot,
} from "./users";

const MARKET_BENCHMARK_SYMBOL = "SPY";

/**
 * Aggregated stats from a price-alert run: symbols checked, alerts sent,
 * cooldown skips (when claim_market_asset_price_alert_slot returned false),
 * and delivery counts (email/SMS success/fail).
 */
export interface PriceAlertTotals extends PriceAlertDeliveryStats {
	symbolsChecked: number;
	alertsTriggered: number;
	cooldownSkips: number;
}

async function fetchEarningsSymbols(supabase: SupabaseAdminClient): Promise<Set<string>> {
	try {
		const now = new Date();
		const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const to = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const { data, error } = await supabase
			.from("asset_events")
			.select("symbol")
			.eq("event_type", "earnings")
			.gte("event_date", from)
			.lte("event_date", to);
		if (error) {
			rootLogger.error(
				"Failed to query asset_events for price alerts",
				{ action: "fetch_earnings_symbols" },
				error,
			);
			return new Set();
		}
		return new Set((data ?? []).map((e) => e.symbol));
	} catch (err) {
		rootLogger.error(
			"Failed to fetch earnings symbols for price alerts",
			{ action: "fetch_earnings_symbols" },
			err,
		);
		return new Set();
	}
}

function calculatePercentMove(quote: ExtendedAssetQuote): number | null {
	if (quote.prevClose !== null && quote.prevClose > 0) {
		return ((quote.price - quote.prevClose) / quote.prevClose) * 100;
	}
	if (Number.isFinite(quote.changePercent)) {
		return quote.changePercent;
	}
	return null;
}

function calculateDollarMove(quote: ExtendedAssetQuote, percentMove: number | null): number | null {
	if (quote.prevClose !== null && quote.prevClose > 0) {
		return quote.price - quote.prevClose;
	}
	if (percentMove === null) {
		return null;
	}
	const denominator = 1 + percentMove / 100;
	if (Math.abs(denominator) < 0.000001) {
		return null;
	}
	const inferredPrevClose = quote.price / denominator;
	return quote.price - inferredPrevClose;
}

function buildSignalContexts(options: {
	percentMove: number;
	dollarMove: number;
	anomalyScore: number;
	maxPossibleScore: number;
	anomalySummary: string;
	hasEarningsNearby: boolean;
	benchmarkMovePercentAbs: number | null;
	benchmarkMoveSigned: number | null;
	benchmarkLabel: string;
}): { grokContext: string; userSignalContext: string } {
	const {
		percentMove,
		dollarMove,
		anomalyScore,
		maxPossibleScore,
		anomalySummary,
		hasEarningsNearby,
		benchmarkMovePercentAbs,
		benchmarkMoveSigned,
		benchmarkLabel,
	} = options;
	const direction = percentMove >= 0 ? "Up" : "Down";
	const absPct = Math.abs(percentMove).toFixed(2);
	const absDollar = Math.abs(dollarMove).toFixed(2);

	// Grok context: technical detail for AI enrichment
	const grokBase = `${direction.toLowerCase()} ${absPct}% ($${absDollar}) from previous close`;
	const scoreLabel = `anomaly score ${anomalyScore}/${maxPossibleScore} (${anomalySummary})`;
	const grokMarket =
		benchmarkMovePercentAbs !== null
			? `${benchmarkLabel} moved ${benchmarkMovePercentAbs.toFixed(2)}%`
			: null;
	const grokEarnings = hasEarningsNearby ? "earnings are within ~2 days" : null;

	const grokContext = [grokBase, scoreLabel, grokMarket, grokEarnings]
		.filter((value): value is string => value !== null)
		.join(", ");

	// User context: additional info beyond the price move (which priceContext already covers)
	const benchmarkDirection =
		benchmarkMoveSigned !== null ? (benchmarkMoveSigned >= 0 ? "up" : "down") : null;
	const userMarket =
		benchmarkMovePercentAbs !== null && benchmarkDirection !== null
			? `The ${benchmarkLabel} moved ${benchmarkDirection} ${benchmarkMovePercentAbs.toFixed(2)}% today.`
			: null;
	const userEarnings = hasEarningsNearby
		? "Earnings are expected within the next couple of days."
		: null;

	const userSignalContext = [userMarket, userEarnings]
		.filter((value): value is string => value !== null)
		.join(" ");

	return { grokContext, userSignalContext };
}

/**
 * Run the price-alert pipeline: fetch quotes, score anomalies against rolling
 * snapshot history, atomically claim trading-day slots via claimCooldown
 * (INSERT ... ON CONFLICT DO UPDATE), enrich with news and intraday bars,
 * then deliver via email/SMS. Only runs when US market is open.
 */
export async function processPriceAlerts(options: {
	supabase: SupabaseAdminClient;
	marketSession?: MarketSession;
}): Promise<{
	totals: PriceAlertTotals;
	quoteMap: ExtendedQuoteMap;
	isMarketOpen: boolean;
	marketSession: MarketSession;
}> {
	const { supabase, marketSession: marketSessionOverride } = options;
	const totals: PriceAlertTotals = {
		symbolsChecked: 0,
		alertsTriggered: 0,
		cooldownSkips: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		telegramSent: 0,
		telegramFailed: 0,
		logFailures: 0,
	};
	const emptyResult = {
		totals,
		quoteMap: new Map<string, null>(),
		isMarketOpen: false,
		marketSession: "closed" as MarketSession,
	};

	const session = marketSessionOverride ?? (await getCurrentMarketSession());
	const isMarketOpen = session === "regular";
	if (!isMarketOpen) {
		return { ...emptyResult, marketSession: session };
	}

	const { data: allUserAssets, error: assetsError } = await supabase
		.from("user_assets")
		.select("symbol");

	if (assetsError) {
		rootLogger.error(
			"Failed to load user_assets for price alerts",
			{ action: "price_alerts" },
			assetsError,
		);
		return emptyResult;
	}

	const uniqueSymbols = [...new Set((allUserAssets ?? []).map((a) => a.symbol))];
	if (uniqueSymbols.length === 0) {
		return emptyResult;
	}

	// Load sector data and icon URLs for all tracked assets
	const { data: assetRows, error: assetSectorError } = await supabase
		.from("assets")
		.select("symbol, sector, type, icon_url, icon_base64")
		.in("symbol", uniqueSymbols);

	if (assetSectorError) {
		rootLogger.error(
			"Failed to load asset sectors for price alerts",
			{ action: "price_alerts" },
			assetSectorError,
		);
	}

	const assetSectorMap = new Map<string, string | null>();
	const assetTypeMap = new Map<string, string>();
	const assetIconUrlMap = new Map<string, string | null>();
	const assetIconBase64Map = new Map<string, string | null>();
	for (const row of assetRows ?? []) {
		const r = row as {
			symbol: string;
			sector: string | null;
			type: string;
			icon_url: string | null;
			icon_base64: string | null;
		};
		assetSectorMap.set(r.symbol, r.sector);
		assetTypeMap.set(r.symbol, r.type);
		assetIconUrlMap.set(r.symbol, r.icon_url);
		assetIconBase64Map.set(r.symbol, r.icon_base64);
	}

	// Determine which sector ETFs we need as benchmarks
	const neededSectorEtfs = new Set<string>();
	for (const sector of assetSectorMap.values()) {
		if (sector && SECTOR_ETF_MAP[sector]) {
			neededSectorEtfs.add(SECTOR_ETF_MAP[sector]);
		}
	}

	// Build the full symbol list: user assets + SPY + needed sector ETFs
	const benchmarkSymbols = new Set([MARKET_BENCHMARK_SYMBOL, ...neededSectorEtfs]);
	const symbolsWithBenchmarks = [
		...uniqueSymbols,
		...[...benchmarkSymbols].filter((s) => !uniqueSymbols.includes(s)),
	];

	const [quoteMap, earningsSymbols, dailyStatsMap] = await Promise.all([
		fetchExtendedQuotes(symbolsWithBenchmarks, session),
		fetchEarningsSymbols(supabase),
		fetchDailyStats(supabase, uniqueSymbols).catch((err) => {
			rootLogger.error(
				"Failed to load daily_asset_stats; continuing without stats",
				{ symbolCount: uniqueSymbols.length },
				err,
			);
			return new Map();
		}),
	]);

	// Load rolling 60-minute snapshot history for anomaly scoring (before storing
	// current tick, so history excludes the current quote and sudden-move detection works)
	let snapshotMap: Awaited<ReturnType<typeof getSnapshotsForSymbols>> = new Map();
	try {
		snapshotMap = await getSnapshotsForSymbols(supabase, [...uniqueSymbols]);
	} catch (err) {
		rootLogger.error(
			"Failed to load snapshots for anomaly scoring; continuing with empty history",
			{ symbolCount: uniqueSymbols.length },
			err,
		);
	}

	// Persist current tick for the rolling anomaly-detection window.
	// Only store snapshots for user-tracked symbols (uniqueSymbols); benchmark
	// ETFs may not exist in assets table, and FK would fail the entire batch.
	const quoteMapForSnapshots: ExtendedQuoteMap = new Map();
	for (const symbol of uniqueSymbols) {
		const quote = quoteMap.get(symbol);
		if (quote) quoteMapForSnapshots.set(symbol, quote);
	}
	// storeSnapshots logs its own errors and never throws — anomaly detection
	// degrades gracefully if persistence fails, so we continue the alert run.
	await storeSnapshots(supabase, quoteMapForSnapshots);

	const users = await fetchPriceAlertUsers(supabase);
	if (users.length === 0) {
		const filteredQuoteMap: ExtendedQuoteMap = new Map();
		for (const symbol of uniqueSymbols) {
			filteredQuoteMap.set(symbol, quoteMap.get(symbol) ?? null);
		}
		return { totals, quoteMap: filteredQuoteMap, isMarketOpen: true, marketSession: session };
	}

	const { data: userAssetRows, error: userAssetsError } = await supabase
		.from("user_assets")
		.select("user_id, symbol")
		.in(
			"user_id",
			users.map((u) => u.id),
		);

	if (userAssetsError) {
		rootLogger.error(
			"Failed to load user_assets for price alert delivery",
			{ action: "price_alerts" },
			userAssetsError,
		);
		const filteredQuoteMap: ExtendedQuoteMap = new Map();
		for (const symbol of uniqueSymbols) {
			filteredQuoteMap.set(symbol, quoteMap.get(symbol) ?? null);
		}
		return { totals, quoteMap: filteredQuoteMap, isMarketOpen: true, marketSession: session };
	}

	const userSymbolMap = new Map<string, Set<string>>();
	for (const row of userAssetRows ?? []) {
		const existing = userSymbolMap.get(row.user_id) ?? new Set<string>();
		existing.add(row.symbol);
		userSymbolMap.set(row.user_id, existing);
	}

	const { sendEmail, getSmsSender, getTelegramSender, logoCache } = createNotificationSenders();
	let smsSender: ReturnType<typeof getSmsSender>["sender"] | null = null;
	let telegramSender: ReturnType<typeof getTelegramSender>["sender"] | null = null;

	// Pre-compute benchmark moves for SPY and all sector ETFs
	const benchmarkMoveCache = new Map<string, number | null>();
	const benchmarkMoveSignedCache = new Map<string, number | null>();
	for (const etfSymbol of benchmarkSymbols) {
		const etfQuote = quoteMap.get(etfSymbol) ?? null;
		const pctMove = etfQuote === null ? null : calculatePercentMove(etfQuote);
		benchmarkMoveCache.set(etfSymbol, pctMove === null ? null : Math.abs(pctMove));
		benchmarkMoveSignedCache.set(etfSymbol, pctMove);
	}

	const spyMovePercentAbs = benchmarkMoveCache.get(MARKET_BENCHMARK_SYMBOL) ?? null;

	// Freeze early-day flag and time-of-day fraction once per run
	const eastern = DateTime.now().setZone(US_MARKET_TIMEZONE);
	const minutesSinceMidnight = eastern.hour * 60 + eastern.minute;
	const minutesSinceOpen = minutesSinceMidnight - US_MARKET_OPEN_EASTERN_MINUTES;
	const tradingMinutes = US_MARKET_CLOSE_EASTERN_MINUTES - US_MARKET_OPEN_EASTERN_MINUTES;
	const fractionOfTradingDayElapsed = Math.min(1, Math.max(0, minutesSinceOpen / tradingMinutes));
	const isEarlyDay = eastern.hour < 10;
	const maxPossibleScore = isEarlyDay ? 95 : 100;

	for (const symbol of uniqueSymbols) {
		totals.symbolsChecked++;

		// Skip ETFs — they track sectors/markets and aren't suitable for
		// standout-style alerts. Users still get scheduled price updates for ETFs.
		if (assetTypeMap.get(symbol) === "etf") continue;

		const quote = quoteMap.get(symbol);
		if (!quote) continue;

		const percentMove = calculatePercentMove(quote);
		if (percentMove === null) {
			continue;
		}
		const dollarMove = calculateDollarMove(quote, percentMove);
		if (dollarMove === null) {
			continue;
		}

		// Resolve sector-specific benchmark for this symbol
		const assetSector = assetSectorMap.get(symbol) ?? null;
		const sectorEtf = assetSector ? (SECTOR_ETF_MAP[assetSector] ?? null) : null;

		// For stocks: prefer sector ETF benchmark, fall back to SPY.
		const benchmarkEtf = sectorEtf ?? MARKET_BENCHMARK_SYMBOL;
		const benchmarkMovePercentAbs = benchmarkMoveCache.get(benchmarkEtf) ?? spyMovePercentAbs;
		const benchmarkLabel = sectorEtf
			? `${assetSector} sector (${sectorEtf})`
			: `broader market (${MARKET_BENCHMARK_SYMBOL})`;

		// Per-symbol anomaly scoring (score is universal; threshold is per-user)
		const snapshots = snapshotMap.get(symbol) ?? [];
		const hasEarningsNearby = earningsSymbols.has(symbol);
		const benchmarkMoveSigned =
			benchmarkMoveSignedCache.get(benchmarkEtf) ??
			benchmarkMoveSignedCache.get(MARKET_BENCHMARK_SYMBOL) ??
			null;

		const stats = dailyStatsMap.get(symbol);
		const anomalyResult = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby,
			benchmarkMovePct: benchmarkMoveSigned,
			avgVolume20d: stats?.avgVolume20d,
			atr14: stats?.atr14,
			isEarlyDay,
			fractionOfTradingDayElapsed,
		});

		const symbolMovePercentAbs = Math.abs(percentMove);
		const symbolMoveDollarAbs = Math.abs(dollarMove);

		const eligibleUsers = [] as Array<(typeof users)[number]>;

		for (const user of users) {
			const userSymbols = userSymbolMap.get(user.id);
			if (!userSymbols?.has(symbol)) continue;

			const userThreshold = getAnomalyThreshold(user.market_asset_price_alert_move_size);
			if (anomalyResult.score < userThreshold) {
				continue;
			}

			const claimed = await reserveCooldownSlot(
				supabase,
				user.id,
				symbol,
				symbolMovePercentAbs,
				symbolMoveDollarAbs,
			);
			if (!claimed) {
				totals.cooldownSkips++;
				continue;
			}

			eligibleUsers.push(user);
		}

		if (eligibleUsers.length === 0) {
			continue;
		}

		rootLogger.info("Anomaly score triggered", {
			symbol,
			score: anomalyResult.score,
			summary: anomalyResult.summary,
			snapshotCount: snapshots.length,
			eligibleUserCount: eligibleUsers.length,
		});

		totals.alertsTriggered++;

		let intradayCloses: number[] | null = null;
		let intradayTimestamps: (number | null)[] | null = null;
		let intradayEndTimestamp: number | null = null;
		let intradayCandles: IntradayCandle[] | null = null;
		try {
			const bars = await fetchIntradayBars(symbol);
			if (bars) {
				intradayCloses = bars.closes;
				intradayTimestamps = bars.timestamps;
				intradayEndTimestamp = bars.endTimestamp;
				intradayCandles = bars.candles;
			}
		} catch (err) {
			rootLogger.error("Failed to fetch intraday bars for price alert enrichment", { symbol }, err);
		}

		// Signal context is per-symbol (universal), so enrich once per symbol
		const { grokContext, userSignalContext } = buildSignalContexts({
			percentMove,
			dollarMove,
			anomalyScore: anomalyResult.score,
			maxPossibleScore,
			anomalySummary: anomalyResult.summary,
			hasEarningsNearby,
			benchmarkMovePercentAbs,
			benchmarkMoveSigned,
			benchmarkLabel,
		});

		let enrichedAlert: EnrichedAlert;
		try {
			enrichedAlert = await enrichAlert({
				symbol,
				quote,
				grokContext,
				userSignalContext,
				intradayCloses,
				intradayTimestamps,
				intradayEndTimestamp,
				intradayCandles,
				iconUrl: assetIconUrlMap.get(symbol) ?? null,
				iconBase64: assetIconBase64Map.get(symbol) ?? null,
				benchmarkDirection:
					benchmarkMoveSigned != null ? (benchmarkMoveSigned >= 0 ? "up" : "down") : null,
			});
		} catch (err) {
			rootLogger.error(
				"Failed to enrich price alert",
				{ symbol, eligibleUserCount: eligibleUsers.length },
				err,
			);
			for (const user of eligibleUsers) {
				await releaseCooldownSlot(supabase, user.id, symbol);
			}
			continue;
		}

		for (const user of eligibleUsers) {
			if (isFacetEnabled(user.prefs, "market_asset_price_alerts", "sms") && !smsSender) {
				try {
					smsSender = getSmsSender().sender;
				} catch (error) {
					rootLogger.error(
						"Failed to initialize SMS sender for price alerts",
						{ action: "price_alerts" },
						error,
					);
				}
			}

			// Mirror the SMS provider threading: lazily build (and cache) the Telegram sender
			// once for any user whose channel is linked. The per-option pref is checked inside
			// deliverPriceAlert; here we only need the channel to be usable.
			if (isTelegramChannelUsable(user) && !telegramSender) {
				try {
					telegramSender = getTelegramSender().sender;
				} catch (error) {
					rootLogger.error(
						"Failed to initialize Telegram sender for price alerts",
						{ action: "price_alerts" },
						error,
					);
				}
			}

			const delivered = await deliverPriceAlert({
				user,
				alert: enrichedAlert,
				supabase,
				sendEmail,
				sendSms: smsSender,
				sendTelegram: telegramSender,
				stats: totals,
				logoCache,
			});

			if (delivered) {
				await finalizeCooldownSlot(supabase, user.id, symbol);
			} else {
				await releaseCooldownSlot(supabase, user.id, symbol);
			}
		}
	}

	const filteredQuoteMap: ExtendedQuoteMap = new Map();
	for (const symbol of uniqueSymbols) {
		filteredQuoteMap.set(symbol, quoteMap.get(symbol) ?? null);
	}

	return { totals, quoteMap: filteredQuoteMap, isMarketOpen: true, marketSession: session };
}
