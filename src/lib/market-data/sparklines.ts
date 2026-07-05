import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import {
	getIntradaySparklineFromCache,
	getSevenDaySparklineFromCache,
} from "../market-data/price-history-cache";
import {
	downsampleEvenly,
	type SparklineMap,
	type SparklineWindow,
	toSparkline,
} from "../messaging/parts/sparkline";
import { fetchDailyCloses, fetchIntradayBars } from "./bars";
import type { SparklineCacheOptions } from "./types";

/** Fetch 7-point sparklines for the last ~week of closes. */
export async function fetchSparklines(
	symbols: string[],
	cacheOptions?: SparklineCacheOptions,
): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	let symbolsToFetch = symbols;

	if (cacheOptions?.supabase) {
		await Promise.all(
			symbols.map(async (symbol) => {
				const cached = await getSevenDaySparklineFromCache(cacheOptions.supabase, symbol, {
					timezone: cacheOptions.timezone,
					use24HourTime: cacheOptions.use24HourTime,
				});
				if (cached) {
					result.set(symbol, cached);
				}
			}),
		);
		symbolsToFetch = symbols.filter((symbol) => !result.has(symbol));
	}

	if (symbolsToFetch.length === 0) {
		return result;
	}

	const todayET = new Date().toLocaleDateString("en-CA", {
		timeZone: US_MARKET_TIMEZONE,
	});
	const to = todayET;
	const from = new Date(new Date(`${todayET}T12:00:00Z`).getTime() - 9 * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	const CONCURRENCY = 5;
	const queue = [...symbolsToFetch];
	const pending: Promise<void>[] = [];

	async function processSymbol(symbol: string): Promise<void> {
		try {
			const closes = await fetchDailyCloses(symbol, from, to);
			if (!closes || closes.length < 2) {
				result.set(symbol, null);
				return;
			}
			const last7 = closes.slice(-7);
			const ascii = toSparkline(last7);
			result.set(symbol, ascii ? { values: last7, ascii, window: "7-trading-days" } : null);
		} catch (error) {
			rootLogger.error("Sparkline fetch failed", { symbol }, createErrorForLogging(error));
			result.set(symbol, null);
		}
	}

	async function worker(): Promise<void> {
		while (true) {
			const symbol = queue.shift();
			if (symbol === undefined) break;
			await processSymbol(symbol);
		}
	}

	for (let i = 0; i < Math.min(CONCURRENCY, symbolsToFetch.length); i++) {
		pending.push(worker());
	}
	await Promise.all(pending);

	return result;
}

function isFinitePositive(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Append the live snapshot quote when it differs from the latest bar close. */
function appendCurrentPriceIfStale(
	values: number[],
	symbol: string,
	currentPriceMap: Map<string, number | null | undefined> | undefined,
): number[] {
	if (!currentPriceMap) return values;
	const rawCurrent = currentPriceMap.get(symbol);
	if (!isFinitePositive(rawCurrent)) return values;
	const last = values[values.length - 1];
	if (last === undefined || last === rawCurrent) return values;
	return [...values, rawCurrent];
}

/**
 * Fetch intraday sparklines (prev close + today's 5-minute bars to now) for the given symbols.
 *
 * Prepending prev close anchors the chart's first-to-last delta to the
 * prev-close-anchored change-% we headline in scheduled/digest/price-alert
 * notifications (derived from price vs `pc` in `parseFinnhubQuote`),
 * so the chart's shape and color always agree with the headline %.
 *
 * Symbols without a valid prev close (delisted / fetch miss) get a sparkline
 * built from today's bars only — better than dropping the chart entirely.
 *
 * When `currentPriceMap` is supplied, the live snapshot quote is appended as
 * the final point whenever it differs from the latest aggregate close. Snapshot
 * `min.c` can move ahead of the 5-minute bar endpoint during pre/after-hours,
 * which otherwise leaves the chart red while the headline change-% is green.
 *
 * `values` holds the full series for SVG rendering; `ascii` is a downsampled
 * block-character series for compact plaintext contexts.
 */
export async function fetchIntradaySparklines(
	symbols: string[],
	prevCloseMap: Map<string, number | null | undefined>,
	currentPriceMap?: Map<string, number | null | undefined>,
	cacheOptions?: SparklineCacheOptions,
): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	const CONCURRENCY = 5;
	const queue = [...symbols];
	const pending: Promise<void>[] = [];

	async function processSymbol(symbol: string): Promise<void> {
		try {
			const bars = await fetchIntradayBars(symbol);
			const todayCloses = bars?.closes ?? null;
			const rawPrev = prevCloseMap.get(symbol);
			const prevClose = isFinitePositive(rawPrev) ? rawPrev : null;
			let values =
				prevClose !== null && todayCloses && todayCloses.length > 0
					? [prevClose, ...todayCloses]
					: (todayCloses ?? []);
			values = appendCurrentPriceIfStale(values, symbol, currentPriceMap);
			if (values.length < 2) {
				result.set(symbol, null);
				return;
			}
			const ascii = toSparkline(downsampleEvenly(values));
			const window: SparklineWindow =
				prevClose !== null ? "intraday-since-prev-close" : "intraday-since-open";
			result.set(symbol, ascii ? { values, ascii, window } : null);
		} catch (error) {
			// Transient Massive failure — next scheduled invocation retries. `warn` keeps the
			// ErrorLogAlarm quiet on degraded-but-functional delivery (user still gets the
			// notification, just without this symbol's sparkline).
			rootLogger.warn("Intraday sparkline fetch failed", { symbol }, createErrorForLogging(error));
			result.set(symbol, null);
		}
	}

	async function worker(): Promise<void> {
		while (true) {
			const symbol = queue.shift();
			if (symbol === undefined) break;
			await processSymbol(symbol);
		}
	}

	for (let i = 0; i < Math.min(CONCURRENCY, symbols.length); i++) {
		pending.push(worker());
	}
	await Promise.all(pending);

	if (cacheOptions?.supabase) {
		for (const symbol of symbols) {
			if (result.get(symbol)) continue;
			const cached = await getIntradaySparklineFromCache(cacheOptions.supabase, symbol, {
				timezone: cacheOptions.timezone,
				use24HourTime: cacheOptions.use24HourTime,
			});
			if (cached) {
				result.set(symbol, cached);
			}
		}
	}

	return result;
}
