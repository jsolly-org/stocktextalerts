import { rootLogger } from "../../logging";
import { type FinnhubFetchPolicy, finnhubFetch } from "./client";

export interface RecommendationTrend {
	buy: number;
	hold: number;
	sell: number;
	strongBuy: number;
	strongSell: number;
	period: string;
}

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

	// Most recent recommendation period is first
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
