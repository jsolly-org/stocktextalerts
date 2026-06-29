import { US_MARKET_TIMEZONE } from "../market-constants";
import type { DailyOHLCVBar, IntradayBarsResult } from "../market-data-types";
import { marketDataFetch } from "../vendors/massive";
import {
	extractClosesAndTimestampsFromBars,
	extractClosesFromBars,
	extractOHLCVFromBars,
} from "./bars-parse";

export async function fetchDailyCloses(
	symbol: string,
	from: string,
	to: string,
): Promise<number[] | null> {
	const data = await marketDataFetch(
		`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`,
		{ sort: "asc", limit: "10" },
		"daily-closes",
	);
	return extractClosesFromBars(data);
}

export async function fetchDailyOHLCV(
	symbol: string,
	from: string,
	to: string,
): Promise<DailyOHLCVBar[] | null> {
	const data = await marketDataFetch(
		`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`,
		{ sort: "asc", limit: "50" },
		"daily-ohlcv",
	);
	return extractOHLCVFromBars(data);
}

const intradayBarsInFlight = new Map<string, Promise<IntradayBarsResult | null>>();

export function fetchIntradayBars(symbol: string): Promise<IntradayBarsResult | null> {
	const existing = intradayBarsInFlight.get(symbol);
	if (existing) return existing;
	const promise = fetchIntradayBarsUncached(symbol).finally(() => {
		intradayBarsInFlight.delete(symbol);
	});
	intradayBarsInFlight.set(symbol, promise);
	return promise;
}

async function fetchIntradayBarsUncached(symbol: string): Promise<IntradayBarsResult | null> {
	const today = new Date().toLocaleDateString("en-CA", {
		timeZone: US_MARKET_TIMEZONE,
	});
	const data = await marketDataFetch(
		`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/5/minute/${today}/${today}`,
		{ sort: "asc", limit: "5000" },
		"intraday-bars",
	);
	return extractClosesAndTimestampsFromBars(data);
}

export async function fetchPrevClose(symbol: string): Promise<number | null> {
	const data = await marketDataFetch(
		`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`,
		{ adjusted: "true" },
		"prev-close",
	);
	if (typeof data !== "object" || data === null) return null;

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results) || results.length === 0) return null;

	const first = results[0];
	if (typeof first !== "object" || first === null) return null;

	const close = (first as Record<string, unknown>).c;
	if (typeof close !== "number" || !Number.isFinite(close) || close === 0) {
		return null;
	}

	return close;
}
