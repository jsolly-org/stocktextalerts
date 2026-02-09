import { finnhubFetch } from "./finnhub-extras";
import { rootLogger } from "./logging";

interface AssetPrice {
	price: number;
	changePercent: number;
}

export type AssetPriceMap = Map<string, AssetPrice | null>;

/**
 * Fetch a single asset quote from Finnhub and normalize it.
 *
 * Returns `null` for invalid/unavailable quotes (including delisted/unknown symbols).
 */
async function fetchAssetQuote(symbol: string): Promise<AssetPrice | null> {
	const data = await finnhubFetch("/quote", { symbol }, "quote");
	if (typeof data !== "object" || data === null) return null;

	const { c, dp } = data as { c?: unknown; dp?: unknown };
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
	return { price: c, changePercent: dp };
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
