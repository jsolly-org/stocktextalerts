import { FINNHUB_BASE_URL } from "./constants";
import { rootLogger } from "./logging";

interface StockPrice {
	price: number;
	changePercent: number;
}

export type StockPriceMap = Map<string, StockPrice | null>;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

async function fetchStockQuote(
	symbol: string,
	apiKey: string,
): Promise<StockPrice | null> {
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		const log = isLastAttempt
			? rootLogger.error.bind(rootLogger)
			: rootLogger.warn.bind(rootLogger);

		try {
			const response = await fetch(
				`${FINNHUB_BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
			);
			if (!response.ok) {
				log("Finnhub quote API error", {
					symbol,
					attempt,
					status: response.status,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return null;
			}
			const data: unknown = await response.json();
			if (typeof data !== "object" || data === null) {
				log("Unexpected Finnhub quote payload structure", {
					symbol,
					attempt,
					payload: data,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return null;
			}

			const { c, dp } = data as { c?: unknown; dp?: unknown };
			if (
				typeof c !== "number" ||
				!Number.isFinite(c) ||
				typeof dp !== "number" ||
				!Number.isFinite(dp)
			) {
				log("Invalid Finnhub quote field types", {
					symbol,
					attempt,
					c,
					dp,
					payload: data,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return null;
			}

			// Finnhub returns 0 for unknown/delisted symbols — not retryable
			if (c === 0) {
				return null;
			}
			return { price: c, changePercent: dp };
		} catch (error) {
			log("Failed to fetch stock quote", { symbol, attempt }, error);
			if (!isLastAttempt) {
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
				continue;
			}
			return null;
		}
	}
	return null;
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

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		const log = isLastAttempt
			? rootLogger.error.bind(rootLogger)
			: rootLogger.warn.bind(rootLogger);

		try {
			const response = await fetch(
				`${FINNHUB_BASE_URL}/stock/market-status?exchange=US&token=${apiKey}`,
			);
			if (!response.ok) {
				log("Finnhub market status API error", {
					attempt,
					status: response.status,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				// Default to closed (show disclaimer) on error
				return false;
			}
			const data: unknown = await response.json();
			if (typeof data !== "object" || data === null) {
				log("Unexpected Finnhub market status payload structure", {
					attempt,
					payload: data,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return false;
			}

			const isOpen =
				"isOpen" in data ? (data as { isOpen?: unknown }).isOpen : undefined;
			if (typeof isOpen !== "boolean") {
				log("Invalid Finnhub market status field types", {
					attempt,
					isOpen,
					payload: data,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return false;
			}

			return isOpen;
		} catch (error) {
			log(
				"Failed to fetch market status",
				{ component: "price-fetcher", action: "fetchMarketStatus", attempt },
				error,
			);
			if (!isLastAttempt) {
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
				continue;
			}
			// Default to closed (show disclaimer) on error
			return false;
		}
	}
	// Default to closed (show disclaimer) if all retries exhausted
	return false;
}
