import { rootLogger } from "../logging";
import { type SparklineMap, toSparkline } from "../messaging/sparkline";
import { finnhubFetch } from "./finnhub";
import { fetchDailyCloses, fetchSnapshotQuotes } from "./massive";

interface AssetPrice {
	price: number;
	changePercent: number;
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

/**
 * Fetch quotes for a list of symbols and return a map keyed by symbol.
 *
 * Uses Massive's batch snapshot API (single HTTP call) to avoid per-symbol rate limits.
 * In test mode, returns deterministic dummy data to avoid external API calls.
 */
export async function fetchAssetPrices(
	symbols: string[],
): Promise<AssetPriceMap> {
	if (import.meta.env.MODE === "test") {
		return new Map(
			symbols.map((s) => [s, { price: 150.0, changePercent: 1.25 }]),
		);
	}
	const snapshot = await fetchSnapshotQuotes(symbols);
	return snapshot as AssetPriceMap;
}

/**
 * Fetch extended quotes for a list of symbols (includes day high/low/open/prevClose).
 *
 * Uses Massive's batch snapshot API (single HTTP call) to avoid per-symbol rate limits.
 * Used by market movement alerts to store rolling-window snapshots with richer data.
 * In test mode, returns deterministic dummy data.
 */
export async function fetchExtendedQuotes(
	symbols: string[],
): Promise<ExtendedQuoteMap> {
	if (import.meta.env.MODE === "test") {
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
	return snapshot as ExtendedQuoteMap;
}

/**
 * Fetch weekly sparklines for a list of symbols.
 *
 * Fetches 9 calendar days of daily closes per symbol (to cover ~7 trading days),
 * takes the last 7 data points, and converts to a Unicode sparkline.
 * In test mode, returns deterministic data to avoid external API calls.
 */
export async function fetchSparklines(
	symbols: string[],
): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	if (import.meta.env.MODE === "test") {
		for (const s of symbols) {
			result.set(s, "▁▂▃▅▇▅▃");
		}
		return result;
	}

	const today = new Date();
	const to = today.toISOString().slice(0, 10);
	const from = new Date(today.getTime() - 9 * 24 * 60 * 60 * 1000)
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
			const sparkline = toSparkline(last7);
			result.set(symbol, sparkline || null);
		} catch {
			result.set(symbol, null);
		}
	}

	async function worker(): Promise<void> {
		while (queue.length > 0) {
			const symbol = queue.shift()!;
			await processSymbol(symbol);
		}
	}

	for (let i = 0; i < Math.min(CONCURRENCY, symbols.length); i++) {
		pending.push(worker());
	}
	await Promise.all(pending);

	return result;
}

/**
 * Determine whether the US market is currently open.
 *
 * Defaults to "closed" on errors (safer UX: show a disclaimer rather than silently assuming open).
 * In test mode, always returns `true`.
 */
export async function fetchMarketStatus(): Promise<boolean> {
	if (import.meta.env.MODE === "test") {
		return true;
	}

	const data = await finnhubFetch(
		"/stock/market-status",
		{ exchange: "US" },
		"market-status",
	);
	if (typeof data !== "object" || data === null) {
		// Default to closed (show disclaimer) on error
		return false;
	}

	const isOpen =
		"isOpen" in data ? (data as { isOpen?: unknown }).isOpen : undefined;
	if (typeof isOpen !== "boolean") {
		rootLogger.warn("Invalid Finnhub market status field types", {
			isOpen,
			payload: data,
		});
		// Default to closed (show disclaimer) on error
		return false;
	}

	return isOpen;
}
