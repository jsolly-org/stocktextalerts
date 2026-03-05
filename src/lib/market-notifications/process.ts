import { rootLogger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import { createLogoCache } from "../messaging/logo-fetcher";
import { fetchIntradayBars } from "../providers/massive";
import {
	type ExtendedAssetQuote,
	type ExtendedQuoteMap,
	fetchExtendedQuotes,
	fetchMarketStatus,
} from "../providers/price-fetcher";
import { SECTOR_ETF_MAP } from "../providers/sector-mapping";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { createSmsSenderProvider } from "../schedule/sms-sender";
import { deriveAlertProfile } from "./alert-profile";
import { deliverPriceAlert, type PriceAlertDeliveryStats } from "./delivery";
import { enrichAlert } from "./enrichment";
import { claimCooldown, fetchPriceAlertUsers } from "./users";

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

async function fetchEarningsSymbols(
	supabase: SupabaseAdminClient,
): Promise<Set<string>> {
	try {
		const now = new Date();
		const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		const to = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		const { data, error } = await supabase
			.from("asset_events")
			.select("symbol")
			.eq("event_type", "earnings")
			.gte("event_date", from)
			.lte("event_date", to);
		if (error) {
			rootLogger.warn("Failed to query asset_events for price alerts", {
				error: error.message,
			});
			return new Set();
		}
		return new Set((data ?? []).map((e) => e.symbol));
	} catch (err) {
		rootLogger.warn(
			"Failed to fetch earnings symbols for price alerts",
			{},
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

function calculateDollarMove(
	quote: ExtendedAssetQuote,
	percentMove: number | null,
): number | null {
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

function buildSignalContext(options: {
	percentMove: number;
	dollarMove: number;
	percentThreshold: number;
	dollarThreshold: number;
	hasEarningsNearby: boolean;
	benchmarkMovePercentAbs: number | null;
	benchmarkLabel: string;
}): string {
	const {
		percentMove,
		dollarMove,
		percentThreshold,
		dollarThreshold,
		hasEarningsNearby,
		benchmarkMovePercentAbs,
		benchmarkLabel,
	} = options;
	const direction = percentMove >= 0 ? "up" : "down";
	const base = `${direction} ${Math.abs(percentMove).toFixed(2)}% ($${Math.abs(dollarMove).toFixed(2)}) from previous close`;
	const threshold = `triggered when both >=${percentThreshold.toFixed(1)}% and >=$${dollarThreshold.toFixed(2)}`;
	const marketContext =
		benchmarkMovePercentAbs !== null
			? `${benchmarkLabel} moved ${benchmarkMovePercentAbs.toFixed(2)}%`
			: null;
	const earningsContext = hasEarningsNearby
		? "earnings are within ~2 days"
		: null;

	return [base, threshold, marketContext, earningsContext]
		.filter((value): value is string => value !== null)
		.join(", ");
}

/**
 * Run the price-alert pipeline: fetch quotes, evaluate thresholds, atomically
 * claim trading-day slots via claimCooldown (INSERT ... ON CONFLICT DO UPDATE),
 * enrich with news and intraday bars (fetched in parallel), then deliver via email/SMS.
 * Only runs when US market is open.
 */
export async function processPriceAlerts(options: {
	supabase: SupabaseAdminClient;
}): Promise<{
	totals: PriceAlertTotals;
	quoteMap: ExtendedQuoteMap;
	isMarketOpen: boolean;
}> {
	const { supabase } = options;
	const totals: PriceAlertTotals = {
		symbolsChecked: 0,
		alertsTriggered: 0,
		cooldownSkips: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
		logFailures: 0,
	};
	const emptyResult = {
		totals,
		quoteMap: new Map<string, null>(),
		isMarketOpen: false,
	};

	const isMarketOpen = await fetchMarketStatus();
	if (!isMarketOpen) {
		return emptyResult;
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

	const uniqueSymbols = [
		...new Set((allUserAssets ?? []).map((a) => a.symbol)),
	];
	if (uniqueSymbols.length === 0) {
		return emptyResult;
	}

	// Load sector data and icon URLs for all tracked assets
	const { data: assetRows, error: assetSectorError } = await supabase
		.from("assets")
		.select("symbol, sector, type, icon_url, icon_base64")
		.in("symbol", uniqueSymbols);

	if (assetSectorError) {
		rootLogger.warn(
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
	const benchmarkSymbols = new Set([
		MARKET_BENCHMARK_SYMBOL,
		...neededSectorEtfs,
	]);
	const symbolsWithBenchmarks = [
		...uniqueSymbols,
		...[...benchmarkSymbols].filter((s) => !uniqueSymbols.includes(s)),
	];

	const [quoteMap, earningsSymbols] = await Promise.all([
		fetchExtendedQuotes(symbolsWithBenchmarks),
		fetchEarningsSymbols(supabase),
	]);

	const users = await fetchPriceAlertUsers(supabase);
	if (users.length === 0) {
		const filteredQuoteMap: ExtendedQuoteMap = new Map();
		for (const symbol of uniqueSymbols) {
			filteredQuoteMap.set(symbol, quoteMap.get(symbol) ?? null);
		}
		return { totals, quoteMap: filteredQuoteMap, isMarketOpen: true };
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
		return { totals, quoteMap: filteredQuoteMap, isMarketOpen: true };
	}

	const userSymbolMap = new Map<string, Set<string>>();
	for (const row of userAssetRows ?? []) {
		const existing = userSymbolMap.get(row.user_id) ?? new Set<string>();
		existing.add(row.symbol);
		userSymbolMap.set(row.user_id, existing);
	}

	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();
	let smsSender: ReturnType<typeof getSmsSender>["sender"] | null = null;
	const logoCache = createLogoCache();

	// Pre-compute benchmark moves for SPY and all sector ETFs
	const benchmarkMoveCache = new Map<string, number | null>();
	for (const etfSymbol of benchmarkSymbols) {
		const etfQuote = quoteMap.get(etfSymbol) ?? null;
		const pctMove = etfQuote === null ? null : calculatePercentMove(etfQuote);
		benchmarkMoveCache.set(
			etfSymbol,
			pctMove === null ? null : Math.abs(pctMove),
		);
	}

	const spyMovePercentAbs =
		benchmarkMoveCache.get(MARKET_BENCHMARK_SYMBOL) ?? null;

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
		const sectorEtf = assetSector
			? (SECTOR_ETF_MAP[assetSector] ?? null)
			: null;

		// For stocks: prefer sector ETF benchmark, fall back to SPY.
		const benchmarkEtf = sectorEtf ?? MARKET_BENCHMARK_SYMBOL;
		const benchmarkMovePercentAbs =
			benchmarkMoveCache.get(benchmarkEtf) ?? spyMovePercentAbs;
		const benchmarkLabel = sectorEtf
			? `${assetSector} sector (${sectorEtf})`
			: `market (${MARKET_BENCHMARK_SYMBOL})`;

		const eligibleUsers = [] as Array<
			(typeof users)[number] & {
				profile: ReturnType<typeof deriveAlertProfile>;
			}
		>;
		const symbolMovePercentAbs = Math.abs(percentMove);
		const symbolMoveDollarAbs = Math.abs(dollarMove);

		for (const user of users) {
			const userSymbols = userSymbolMap.get(user.id);
			if (!userSymbols?.has(symbol)) continue;

			const profile = deriveAlertProfile(
				user.market_asset_price_alert_move_size,
			);

			const meetsShockThreshold =
				symbolMovePercentAbs >= profile.percentThreshold ||
				symbolMoveDollarAbs >= profile.dollarThreshold;
			if (!meetsShockThreshold) {
				continue;
			}

			const claimed = await claimCooldown(
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

			eligibleUsers.push({ ...user, profile });
		}

		if (eligibleUsers.length === 0) {
			continue;
		}

		totals.alertsTriggered++;

		let intradayCloses: number[] | null = null;
		let intradayTimestamps: (number | null)[] | null = null;
		let intradayEndTimestamp: number | null = null;
		try {
			const bars = await fetchIntradayBars(symbol);
			if (bars) {
				intradayCloses = bars.closes;
				intradayTimestamps = bars.timestamps;
				intradayEndTimestamp = bars.endTimestamp;
			}
		} catch (err) {
			rootLogger.warn(
				"Failed to fetch intraday bars for price alert enrichment",
				{ symbol },
				err,
			);
		}

		const enrichedBySignal = new Map<
			string,
			Awaited<ReturnType<typeof enrichAlert>>
		>();
		for (const user of eligibleUsers) {
			const signalContext = buildSignalContext({
				percentMove,
				dollarMove,
				percentThreshold: user.profile.percentThreshold,
				dollarThreshold: user.profile.dollarThreshold,
				hasEarningsNearby: earningsSymbols.has(symbol),
				benchmarkMovePercentAbs,
				benchmarkLabel,
			});

			let enrichedAlert = enrichedBySignal.get(signalContext);
			if (!enrichedAlert) {
				enrichedAlert = await enrichAlert({
					symbol,
					quote,
					signalContext,
					intradayCloses,
					intradayTimestamps,
					intradayEndTimestamp,
					iconUrl: assetIconUrlMap.get(symbol) ?? null,
					iconBase64: assetIconBase64Map.get(symbol) ?? null,
				});
				enrichedBySignal.set(signalContext, enrichedAlert);
			}

			if (user.market_asset_price_alerts_include_sms && !smsSender) {
				try {
					smsSender = getSmsSender().sender;
				} catch {
					rootLogger.warn("Failed to initialize SMS sender for price alerts");
				}
			}

			await deliverPriceAlert({
				user,
				alert: enrichedAlert,
				supabase,
				sendEmail,
				sendSms: smsSender,
				stats: totals,
				logoCache,
			});
		}
	}

	const filteredQuoteMap: ExtendedQuoteMap = new Map();
	for (const symbol of uniqueSymbols) {
		filteredQuoteMap.set(symbol, quoteMap.get(symbol) ?? null);
	}

	return { totals, quoteMap: filteredQuoteMap, isMarketOpen: true };
}
