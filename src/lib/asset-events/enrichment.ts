import { rootLogger } from "../logging";
import { type InsiderTransaction, isRecord, type RecommendationTrend } from "../types";
import { type FinnhubFetchPolicy, finnhubFetch } from "../vendors/finnhub";

/** Fetch the latest analyst recommendation trend for a ticker (or `null`). */
export async function fetchRecommendationTrends(
	symbol: string,
	policy?: FinnhubFetchPolicy,
): Promise<{
	trend: RecommendationTrend | null;
	httpSucceeded: boolean;
}> {
	const data = await finnhubFetch("/stock/recommendation", { symbol }, "recommendation", policy);
	if (data === null) {
		return { trend: null, httpSucceeded: false };
	}
	if (!Array.isArray(data) || data.length === 0) {
		return { trend: null, httpSucceeded: true };
	}

	const latest = data[0] as Record<string, unknown>;
	const buy = latest.buy;
	const hold = latest.hold;
	const sell = latest.sell;
	const strongBuy = latest.strongBuy;
	const strongSell = latest.strongSell;
	const period = latest.period;

	if (
		typeof buy !== "number" ||
		typeof hold !== "number" ||
		typeof sell !== "number" ||
		typeof strongBuy !== "number" ||
		typeof strongSell !== "number" ||
		typeof period !== "string"
	) {
		rootLogger.error(
			"Invalid Finnhub recommendation fields",
			{ symbol },
			new Error("Invalid Finnhub recommendation fields in API response"),
		);
		return { trend: null, httpSucceeded: true };
	}

	return {
		trend: { buy, hold, sell, strongBuy, strongSell, period },
		httpSucceeded: true,
	};
}

function parseInsiderTransactionsPayload(
	symbol: string,
	data: unknown,
	cutoffDate: string | null,
	maxResults = 5,
): InsiderTransaction[] {
	if (!isRecord(data)) {
		rootLogger.error(
			"Invalid Finnhub insider-transactions payload shape",
			{ symbol, payloadType: typeof data },
			new Error("Invalid Finnhub insider-transactions payload shape"),
		);
		return [];
	}

	const transactions = data.data;
	if (!Array.isArray(transactions)) {
		rootLogger.error(
			"Invalid Finnhub insider-transactions data field",
			{ symbol, dataType: typeof transactions },
			new Error("Invalid Finnhub insider-transactions data field"),
		);
		return [];
	}

	return transactions
		.filter(
			(item: unknown) =>
				isRecord(item) &&
				typeof item.name === "string" &&
				typeof item.change === "number" &&
				typeof item.transactionDate === "string" &&
				(cutoffDate === null || item.transactionDate >= cutoffDate),
		)
		.slice(0, maxResults)
		.map((item: Record<string, unknown>) => ({
			name: item.name as string,
			share: typeof item.share === "number" ? (item.share as number) : 0,
			change: item.change as number,
			transactionType:
				typeof item.transactionType === "string" ? (item.transactionType as string) : "",
			transactionDate: item.transactionDate as string,
		}));
}

/** Fetch insider transactions for a ticker (validated; optional date cutoff). */
export async function fetchInsiderTransactions(
	symbol: string,
	options?: { cutoffDate?: string | null; policy?: FinnhubFetchPolicy; maxResults?: number },
): Promise<InsiderTransaction[]> {
	const data = await finnhubFetch(
		"/stock/insider-transactions",
		{ symbol },
		"insider-transactions",
		options?.policy,
	);
	if (data === null) return [];

	const cutoffDate =
		options?.cutoffDate === undefined
			? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
			: options.cutoffDate;

	return parseInsiderTransactionsPayload(symbol, data, cutoffDate, options?.maxResults ?? 5);
}
