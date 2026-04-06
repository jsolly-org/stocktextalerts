import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import { type SparklineMap, toSparkline } from "../messaging/sparkline";
import { fetchFinnhubQuote } from "./finnhub";
import {
	fetchDailyCloses,
	fetchPrevClose,
	fetchSnapshotQuotes,
	marketDataFetch,
} from "./massive";

interface AssetPrice {
	price: number;
	changePercent: number;
	timestamp?: number | null;
}

/** Quote fields used by movement alerts and snapshot persistence. */
export interface ExtendedAssetQuote extends AssetPrice {
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

/** Map of simple price quotes keyed by symbol. */
export type AssetPriceMap = Map<string, AssetPrice | null>;
/** Map of extended quotes keyed by symbol. */
export type ExtendedQuoteMap = Map<string, ExtendedAssetQuote | null>;

function isLiveMassiveEnabledInTests(): boolean {
	const enabled =
		process.env.LIVE_API_PROVIDERS ?? process.env.TEST_LIVE_PROVIDERS;
	if (!enabled) return false;
	return enabled
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.includes("massive");
}

/** Fetch quotes for a list of symbols and return a map keyed by symbol. */
export async function fetchAssetPrices(
	symbols: string[],
): Promise<AssetPriceMap> {
	if (import.meta.env.MODE === "test" && !isLiveMassiveEnabledInTests()) {
		return new Map(
			symbols.map((s) => [s, { price: 150.0, changePercent: 1.25 }]),
		);
	}
	const snapshot = await fetchSnapshotQuotes(symbols);

	const missingSymbols = symbols.filter(
		(symbol) => snapshot.get(symbol) === null,
	);
	if (missingSymbols.length === 0) {
		return snapshot as AssetPriceMap;
	}

	// Fallback: fetch missing symbols (typically OTC tickers) from Finnhub
	const finnhubFailures: string[] = [];
	for (const symbol of missingSymbols) {
		try {
			const quote = await fetchFinnhubQuote(symbol);
			if (quote !== null) {
				snapshot.set(symbol, quote);
			} else {
				finnhubFailures.push(symbol);
			}
		} catch (error) {
			finnhubFailures.push(symbol);
			rootLogger.info("Finnhub quote fallback failed", {
				symbol,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (
		finnhubFailures.length > 0 &&
		finnhubFailures.length === missingSymbols.length
	) {
		rootLogger.warn("All Finnhub quote fallbacks failed", {
			failedSymbols: finnhubFailures,
			total: missingSymbols.length,
		});
	}

	const stillMissing = symbols.filter(
		(symbol) => snapshot.get(symbol) === null,
	);
	if (stillMissing.length === 0) {
		return snapshot as AssetPriceMap;
	}

	const isMarketOpen = await fetchMarketStatus();
	if (isMarketOpen) {
		return snapshot as AssetPriceMap;
	}

	for (const symbol of stillMissing) {
		try {
			const prevClose = await fetchPrevClose(symbol);
			if (prevClose !== null) {
				snapshot.set(symbol, {
					price: prevClose,
					changePercent: 0,
					dayHigh: null,
					dayLow: null,
					dayOpen: null,
					prevClose,
					timestamp: null,
					volume: null,
				});
			}
		} catch (error) {
			rootLogger.warn("Failed to fetch prev-close fallback", {
				symbol,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return snapshot as AssetPriceMap;
}

/** Fetch extended quotes for symbols (day high/low/open/prevClose + volume). */
export async function fetchExtendedQuotes(
	symbols: string[],
): Promise<ExtendedQuoteMap> {
	if (import.meta.env.MODE === "test" && !isLiveMassiveEnabledInTests()) {
		return new Map(
			symbols.map((s) => [
				s,
				{
					price: 150.0,
					changePercent: 1.25,
					dayHigh: 152.0,
					dayLow: 148.0,
					dayOpen: 149.0,
					prevClose: 148.5,
					timestamp: Math.floor(Date.now() / 1000),
					volume: null,
				},
			]),
		);
	}
	const snapshot = await fetchSnapshotQuotes(symbols);

	// Fallback: fetch missing symbols (typically OTC tickers) from Finnhub
	const missingSymbols = symbols.filter(
		(symbol) => snapshot.get(symbol) === null,
	);
	const extFinnhubFailures: string[] = [];
	for (const symbol of missingSymbols) {
		try {
			const quote = await fetchFinnhubQuote(symbol);
			if (quote !== null) {
				snapshot.set(symbol, quote);
			} else {
				extFinnhubFailures.push(symbol);
			}
		} catch (error) {
			extFinnhubFailures.push(symbol);
			rootLogger.info("Finnhub quote fallback failed", {
				symbol,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (
		extFinnhubFailures.length > 0 &&
		extFinnhubFailures.length === missingSymbols.length
	) {
		rootLogger.warn("All Finnhub quote fallbacks failed", {
			failedSymbols: extFinnhubFailures,
			total: missingSymbols.length,
		});
	}

	return snapshot as ExtendedQuoteMap;
}

/** Fetch 7-point sparklines for the last ~week of closes. */
export async function fetchSparklines(
	symbols: string[],
): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	if (import.meta.env.MODE === "test" && !isLiveMassiveEnabledInTests()) {
		const stubValues = [1, 2, 3, 5, 7, 5, 3];
		for (const s of symbols) {
			result.set(s, { values: stubValues, ascii: "▁▂▃▅▇▅▃" });
		}
		return result;
	}

	const todayET = new Date().toLocaleDateString("en-CA", {
		timeZone: US_MARKET_TIMEZONE,
	});
	const to = todayET;
	const from = new Date(
		new Date(`${todayET}T12:00:00Z`).getTime() - 9 * 24 * 60 * 60 * 1000,
	)
		.toISOString()
		.slice(0, 10);

	const CONCURRENCY = 5;
	const queue = [...symbols];
	const pending: Promise<void>[] = [];

	async function processSymbol(symbol: string): Promise<void> {
		try {
			const closes = await fetchDailyCloses(symbol, from, to);
			if (!closes || closes.length < 2) {
				result.set(symbol, null);
				return;
			}
			const last7 = closes.slice(-7);
			const ascii = toSparkline(last7);
			result.set(symbol, ascii ? { values: last7, ascii } : null);
		} catch {
			result.set(symbol, null);
		}
	}

	async function worker(): Promise<void> {
		while (true) {
			const symbol = queue.shift();
			if (symbol === undefined) break;
			await processSymbol(symbol);
		}
	}

	for (let i = 0; i < Math.min(CONCURRENCY, symbols.length); i++) {
		pending.push(worker());
	}
	await Promise.all(pending);

	return result;
}

/** Return whether the US market is currently open (best-effort; defaults to closed). */
export async function fetchMarketStatus(): Promise<boolean> {
	if (import.meta.env.MODE === "test" && !isLiveMassiveEnabledInTests()) {
		return true;
	}

	const data = await marketDataFetch(
		"/v1/marketstatus/now",
		{},
		"market-status",
	);
	if (typeof data !== "object" || data === null) {
		return false;
	}

	const market = (data as Record<string, unknown>).market;
	if (typeof market !== "string") {
		rootLogger.warn("Invalid Massive market status field types", {
			market,
			payload: data,
		});
		return false;
	}

	return market === "open";
}
