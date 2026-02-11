import { finnhubFetch } from "./finnhub-extras";
import { rootLogger } from "./logging";

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
 * Fetch a single asset quote from Finnhub and normalize it.
 *
 * Returns `null` for invalid/unavailable quotes (including delisted/unknown symbols).
 * Extracts extended fields (h, l, o, pc, t) when available for instant alerts.
 */
async function fetchAssetQuote(
	symbol: string,
): Promise<ExtendedAssetQuote | null> {
	const data = await finnhubFetch("/quote", { symbol }, "quote");
	if (typeof data !== "object" || data === null) return null;

	const { c, dp, h, l, o, pc, t, v } = data as {
		c?: unknown;
		dp?: unknown;
		h?: unknown;
		l?: unknown;
		o?: unknown;
		pc?: unknown;
		t?: unknown;
		v?: unknown;
	};
	if (
		typeof c !== "number" ||
		!Number.isFinite(c) ||
		typeof dp !== "number" ||
		!Number.isFinite(dp)
	) {
		rootLogger.warn("Invalid Finnhub quote field types", {
			symbol,
			c,
			dp,
			payload: data,
		});
		return null;
	}

	// Finnhub returns 0 for unknown/delisted symbols — not retryable
	if (c === 0) {
		return null;
	}

	return {
		price: c,
		changePercent: dp,
		dayHigh: typeof h === "number" && Number.isFinite(h) && h !== 0 ? h : null,
		dayLow: typeof l === "number" && Number.isFinite(l) && l !== 0 ? l : null,
		dayOpen: typeof o === "number" && Number.isFinite(o) && o !== 0 ? o : null,
		prevClose:
			typeof pc === "number" && Number.isFinite(pc) && pc !== 0 ? pc : null,
		timestamp: typeof t === "number" && Number.isFinite(t) ? t : null,
		volume: typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null,
	};
}

/**
 * Fetch quotes for a list of symbols and return a map keyed by symbol.
 *
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
	const results = await Promise.all(
		symbols.map(async (symbol) => {
			const price = await fetchAssetQuote(symbol);
			return [symbol, price] as const;
		}),
	);
	return new Map(results);
}

/**
 * Fetch extended quotes for a list of symbols (includes day high/low/open/prevClose).
 *
 * Used by instant alerts to store rolling-window snapshots with richer data.
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
	const results = await Promise.all(
		symbols.map(async (symbol) => {
			const quote = await fetchAssetQuote(symbol);
			return [symbol, quote] as const;
		}),
	);
	return new Map(results);
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
