import { FINNHUB_BASE_URL } from "./constants";
import { rootLogger } from "./logging";

export interface StockPrice {
	price: number;
	changePercent: number;
}

export type StockPriceMap = Map<string, StockPrice | null>;

async function fetchStockQuote(
	symbol: string,
	apiKey: string,
): Promise<StockPrice | null> {
	try {
		const response = await fetch(
			`${FINNHUB_BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
		);
		if (!response.ok) {
			rootLogger.error("Finnhub quote API error", {
				symbol,
				status: response.status,
			});
			return null;
		}
		const data: unknown = await response.json();
		if (typeof data !== "object" || data === null) {
			rootLogger.error("Unexpected Finnhub quote payload", {
				symbol,
				payload: data,
			});
			return null;
		}

		const { c, dp } = data as { c?: unknown; dp?: unknown };
		if (
			typeof c !== "number" ||
			!Number.isFinite(c) ||
			typeof dp !== "number" ||
			!Number.isFinite(dp)
		) {
			rootLogger.error("Unexpected Finnhub quote payload", {
				symbol,
				payload: data,
			});
			return null;
		}

		// Finnhub returns 0 for unknown/delisted symbols
		if (c === 0) {
			return null;
		}
		return { price: c, changePercent: dp };
	} catch (error) {
		rootLogger.error("Failed to fetch stock quote", { symbol }, error);
		return null;
	}
}

export async function fetchStockPrices(
	symbols: string[],
): Promise<StockPriceMap> {
	if (import.meta.env.MODE === "test") {
		return new Map(
			symbols.map((s) => [s, { price: 150.0, changePercent: 1.25 }]),
		);
	}
	const apiKey = import.meta.env.FINNHUB_API_KEY;
	const results = await Promise.all(
		symbols.map(async (symbol) => {
			const price = await fetchStockQuote(symbol, apiKey);
			return [symbol, price] as const;
		}),
	);
	return new Map(results);
}

export async function fetchMarketStatus(): Promise<boolean> {
	if (import.meta.env.MODE === "test") {
		return true;
	}
	const apiKey = import.meta.env.FINNHUB_API_KEY;
	try {
		const response = await fetch(
			`${FINNHUB_BASE_URL}/stock/market-status?exchange=US&token=${apiKey}`,
		);
		if (!response.ok) {
			rootLogger.error("Finnhub market status API error", {
				status: response.status,
			});
			// Default to closed (show disclaimer) on error
			return false;
		}
		const data = await response.json();
		return data.isOpen === true;
	} catch (error) {
		rootLogger.error(
			"Failed to fetch market status",
			{ component: "price-fetcher", action: "fetchMarketStatus" },
			error,
		);
		// Default to closed (show disclaimer) on error
		return false;
	}
}
