import { finnhubFetch } from "./finnhub-extras";
import { rootLogger } from "./logging";

interface StockPrice {
	price: number;
	changePercent: number;
}

export type StockPriceMap = Map<string, StockPrice | null>;

async function fetchStockQuote(symbol: string): Promise<StockPrice | null> {
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

export async function fetchStockPrices(
	symbols: string[],
): Promise<StockPriceMap> {
	if (import.meta.env.MODE === "test") {
		return new Map(
			symbols.map((s) => [s, { price: 150.0, changePercent: 1.25 }]),
		);
	}
	const results = await Promise.all(
		symbols.map(async (symbol) => {
			const price = await fetchStockQuote(symbol);
			return [symbol, price] as const;
		}),
	);
	return new Map(results);
}

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
