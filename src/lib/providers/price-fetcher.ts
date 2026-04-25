import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import { type SparklineMap, toSparkline } from "../messaging/sparkline";
import { isTest } from "../runtime/mode";
import {
	fetchDailyCloses,
	fetchPrevDayBar,
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
	if (isTest() && !isLiveMassiveEnabledInTests()) {
		return new Map(
			symbols.map((s) => [s, { price: 150.0, changePercent: 1.25 }]),
		);
	}
	const snapshot = await fetchSnapshotQuotes(symbols);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot);
	return snapshot as AssetPriceMap;
}

/** Fetch extended quotes for symbols (day high/low/open/prevClose + volume). */
export async function fetchExtendedQuotes(
	symbols: string[],
): Promise<ExtendedQuoteMap> {
	if (isTest() && !isLiveMassiveEnabledInTests()) {
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
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot);
	return snapshot as ExtendedQuoteMap;
}

/**
 * Fill snapshot misses with Massive's previous-day bar.
 *
 * Fires only for symbols Massive's live snapshot doesn't return. In practice
 * that means either (a) a legitimately delisted ticker that the daily sweep
 * hasn't cleaned up yet, or (b) a truly OTC ticker Massive's snapshot doesn't
 * cover (rare, but historically why the Finnhub fallback existed).
 *
 * **Market-hours guard**: during trading hours we intentionally skip this
 * fallback. A snapshot miss during RTH is more likely transient (rate limit,
 * brief Massive outage) than structural, and serving yesterday's bar labeled
 * as "current" would mislead users whose alerts compare against live price.
 * When the market is closed, the prev-day bar is the freshest data available
 * and serving it is the right call. This preserves the semantic the old
 * `fetchPrevClose` fallback had before the Finnhub removal refactor.
 */
async function fillSnapshotMissesWithPrevDayBar(
	symbols: string[],
	snapshot: Map<string, unknown>,
): Promise<void> {
	const missing = symbols.filter((symbol) => snapshot.get(symbol) === null);
	if (missing.length === 0) return;

	const isMarketOpen = await fetchMarketStatus();
	if (isMarketOpen) {
		// Leave misses as null rather than serving stale data during RTH —
		// downstream callers already handle null quotes gracefully.
		return;
	}

	for (const symbol of missing) {
		try {
			const bar = await fetchPrevDayBar(symbol);
			if (bar !== null) {
				snapshot.set(symbol, bar);
			}
		} catch (error) {
			rootLogger.error(
				"Prev-day-bar fallback failed",
				{ symbol },
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}
}

/** Fetch 7-point sparklines for the last ~week of closes. */
export async function fetchSparklines(
	symbols: string[],
): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	if (isTest() && !isLiveMassiveEnabledInTests()) {
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
		} catch (error) {
			rootLogger.error(
				"Sparkline fetch failed",
				{ symbol },
				error instanceof Error ? error : new Error(String(error)),
			);
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
	if (isTest() && !isLiveMassiveEnabledInTests()) {
		return true;
	}

	const data = await marketDataFetch(
		"/v1/marketstatus/now",
		{},
		"market-status",
	);
	if (typeof data !== "object" || data === null) {
		rootLogger.error("Invalid Massive market status payload shape", {
			payloadType: typeof data,
		});
		return false;
	}

	const market = (data as Record<string, unknown>).market;
	if (typeof market !== "string") {
		rootLogger.error("Invalid Massive market status field types", {
			market,
			payload: data,
		});
		return false;
	}

	return market === "open";
}
