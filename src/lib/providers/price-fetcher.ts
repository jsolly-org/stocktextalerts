import { rootLogger } from "../logging";
import { finnhubFetch } from "./finnhub";
import { fetchPolygonSnapshotQuotes } from "./polygon";

interface AssetPrice {
	price: number;
	changePercent: number;
}

export interface ExtendedAssetQuote extends AssetPrice {
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

export type AssetPriceMap = Map<string, AssetPrice | null>;
export type ExtendedQuoteMap = Map<string, ExtendedAssetQuote | null>;

/**
 * Fetch quotes for a list of symbols and return a map keyed by symbol.
 *
 * Uses Polygon's batch snapshot API (single HTTP call) to avoid per-symbol rate limits.
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
	const snapshot = await fetchPolygonSnapshotQuotes(symbols);
	const result: AssetPriceMap = new Map();
	for (const [symbol, quote] of snapshot) {
		result.set(symbol, quote);
	}
	return result;
}

/**
 * Fetch extended quotes for a list of symbols (includes day high/low/open/prevClose).
 *
 * Uses Polygon's batch snapshot API (single HTTP call) to avoid per-symbol rate limits.
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
	const snapshot = await fetchPolygonSnapshotQuotes(symbols);
	const result: ExtendedQuoteMap = new Map();
	for (const [symbol, quote] of snapshot) {
		result.set(symbol, quote);
	}
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
