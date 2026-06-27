import { US_MARKET_TIMEZONE } from "../../constants";
import { marketDataFetch } from "./client";

/**
 * Extract closing prices from a Massive bars API response.
 *
 * Expects a payload with a `results` array of bar objects, each with an optional `c` (close) field.
 * Returns `null` for non-object payloads, missing or invalid `results`, or when no valid bars exist.
 * Extracts only finite numeric `c` values; ignores non-numeric, NaN, and Infinity.
 * Returns closes in the same order as the bars in `results`.
 */
export function extractClosesFromBars(payload: unknown): number[] | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const closes: number[] = [];
	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const c = (bar as Record<string, unknown>).c;
		if (typeof c === "number" && Number.isFinite(c)) {
			closes.push(c);
		}
	}
	return closes.length > 0 ? closes : null;
}

/** Result of extracting closes and timestamps from intraday bars. */
export interface IntradayBarsResult {
	closes: number[];
	/** Per-bar timestamps (ms since epoch), same length as closes. null for bars lacking t; downstream places points at real time for valid entries. Null when no bars have timestamps. */
	timestamps: (number | null)[] | null;
	/** First bar timestamp (ms since epoch), or null if bars lack timestamps. */
	startTimestamp: number | null;
	/** Last bar timestamp (ms since epoch), or null if bars lack timestamps. When trailing bars lack timestamps, extrapolated from the average interval so the time axis aligns with the last plotted point. */
	endTimestamp: number | null;
	/** Per-bar OHLC candles (only bars with finite o/h/l/c/t), for candlestick rendering. Null when no bar carried full OHLC+t. Independent of `closes`/`timestamps`, which stay intact for the sparkline path. */
	candles: IntradayCandle[] | null;
}

/**
 * Extract closing prices and bar timestamps from a Massive bars API response.
 *
 * Expects bar objects with `c` (close) and `t` (timestamp in ms). Returns `null` when
 * no valid bars exist. Preserves per-bar timestamps so downstream can place points on
 * real time positions (avoids misalignment when intraday bars are non-uniform).
 */
export function extractClosesAndTimestampsFromBars(payload: unknown): IntradayBarsResult | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const closes: number[] = [];
	const timestamps: (number | null)[] = [];
	let startTimestamp: number | null = null;
	let endTimestamp: number | null = null;
	let firstValidTimestampIndex = -1;
	let lastValidTimestampIndex = -1;

	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const rec = bar as Record<string, unknown>;
		const c = rec.c;
		const t = rec.t;
		if (typeof c !== "number" || !Number.isFinite(c)) continue;
		const ts = typeof t === "number" && Number.isFinite(t) ? t : null;
		closes.push(c);
		if (ts !== null) {
			timestamps.push(ts);
			if (startTimestamp === null) {
				startTimestamp = ts;
				firstValidTimestampIndex = closes.length - 1;
			}
			endTimestamp = ts;
			lastValidTimestampIndex = closes.length - 1;
		} else {
			timestamps.push(null); // Sentinel: bar lacks timestamp
		}
	}

	if (closes.length === 0) return null;

	// Reconcile endTimestamp when trailing bars lack timestamps: extrapolate from average
	// interval so the SVG time axis end-label aligns with the last plotted data point.
	if (
		firstValidTimestampIndex >= 0 &&
		lastValidTimestampIndex >= firstValidTimestampIndex &&
		lastValidTimestampIndex < closes.length - 1 &&
		startTimestamp !== null &&
		endTimestamp !== null
	) {
		const validCount = lastValidTimestampIndex - firstValidTimestampIndex + 1;
		if (validCount >= 2) {
			const avgInterval = (endTimestamp - startTimestamp) / (validCount - 1);
			const trailingCount = closes.length - 1 - lastValidTimestampIndex;
			endTimestamp = endTimestamp + trailingCount * avgInterval;
		}
	}

	// Expose per-bar timestamps when we have any valid t; use null for bars lacking t.
	// Candles are parsed from the same payload (additive) so the candlestick chart has
	// real o/h/l/c; the closes/timestamps sparkline path above is unchanged.
	return {
		closes,
		timestamps: startTimestamp !== null ? timestamps : null,
		startTimestamp,
		endTimestamp,
		candles: extractIntradayOHLCV(payload),
	};
}

/** A single intraday OHLC bar (mirrors the chart module's `Candle`; `t` is ms since epoch). */
export interface IntradayCandle {
	o: number;
	h: number;
	l: number;
	c: number;
	t: number;
}

/**
 * Extract per-bar intraday OHLC candles from a Massive bars API response.
 *
 * Mirrors {@link extractOHLCVFromBars} but keeps the per-bar timestamp `t` (ms) and
 * drops volume — the candlestick chart needs o/h/l/c/t, not v. Distinct from
 * {@link extractClosesAndTimestampsFromBars}, which discards o/h/l. A bar is kept only
 * when o/h/l/c/t are all finite numbers, so the chart never receives partial candles.
 * Returns `null` for non-object payloads, missing results, or no valid bars.
 */
export function extractIntradayOHLCV(payload: unknown): IntradayCandle[] | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const candles: IntradayCandle[] = [];
	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const rec = bar as Record<string, unknown>;
		const o = rec.o;
		const h = rec.h;
		const l = rec.l;
		const c = rec.c;
		const t = rec.t;
		if (
			typeof o === "number" &&
			Number.isFinite(o) &&
			typeof h === "number" &&
			Number.isFinite(h) &&
			typeof l === "number" &&
			Number.isFinite(l) &&
			typeof c === "number" &&
			Number.isFinite(c) &&
			typeof t === "number" &&
			Number.isFinite(t)
		) {
			candles.push({ o, h, l, c, t });
		}
	}
	return candles.length > 0 ? candles : null;
}

/**
 * Fetch daily closing prices for a single symbol over a date range.
 *
 * Uses `/v2/aggs/ticker/{symbol}/range/1/day/{from}/{to}?sort=asc&limit=10`.
 * Returns an array of closing prices, or null on failure.
 */
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

/** Single daily OHLCV bar extracted from Massive aggregates. */
export interface DailyOHLCVBar {
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	/** ET trading date (YYYY-MM-DD) from the bar timestamp when available. */
	tradingDate?: string;
}

function barTimestampToTradingDate(timestampMs: number): string | undefined {
	if (!Number.isFinite(timestampMs)) return undefined;
	const date = new Date(timestampMs).toLocaleDateString("en-CA", {
		timeZone: US_MARKET_TIMEZONE,
	});
	return date || undefined;
}

/**
 * Extract full OHLCV bars from a Massive bars API response.
 *
 * Returns `null` for non-object payloads, missing results, or no valid bars.
 */
export function extractOHLCVFromBars(payload: unknown): DailyOHLCVBar[] | null {
	if (typeof payload !== "object" || payload === null) return null;

	const results = (payload as Record<string, unknown>).results;
	if (!Array.isArray(results)) return null;

	const bars: DailyOHLCVBar[] = [];
	for (const bar of results) {
		if (typeof bar !== "object" || bar === null) continue;
		const rec = bar as Record<string, unknown>;
		const o = rec.o;
		const h = rec.h;
		const l = rec.l;
		const c = rec.c;
		const v = rec.v;
		const t = rec.t;
		if (
			typeof o === "number" &&
			Number.isFinite(o) &&
			typeof h === "number" &&
			Number.isFinite(h) &&
			typeof l === "number" &&
			Number.isFinite(l) &&
			typeof c === "number" &&
			Number.isFinite(c) &&
			typeof v === "number" &&
			Number.isFinite(v)
		) {
			const tradingDate = typeof t === "number" ? barTimestampToTradingDate(t) : undefined;
			bars.push({
				open: o,
				high: h,
				low: l,
				close: c,
				volume: v,
				...(tradingDate ? { tradingDate } : {}),
			});
		}
	}
	return bars.length > 0 ? bars : null;
}

/**
 * Fetch daily OHLCV bars for a single symbol over a date range.
 *
 * Uses `/v2/aggs/ticker/{symbol}/range/1/day/{from}/{to}?sort=asc&limit=50`.
 * Returns full OHLCV bars for computing ATR-14 and ADV-20, or null on failure.
 */
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

/** In-flight intraday-bar fetches keyed by symbol, to de-duplicate concurrent requests
 *  for the same symbol across users within a scheduler batch (sparklines are built per
 *  user, so a popular ticker would otherwise be fetched once per holder). Entries are
 *  cleared on settle, so there is no cross-invocation staleness — unlike a retained
 *  module-level cache, which would leak stale bars across warm Lambda invocations.
 *  Mirrors the logo-fetcher `inFlight` dedup. */
const intradayBarsInFlight = new Map<string, Promise<IntradayBarsResult | null>>();

/**
 * Fetch intraday 5-minute closing prices for a single symbol (today, ET timezone).
 *
 * Uses `/v2/aggs/ticker/{symbol}/range/5/minute/{today}/{today}?sort=asc&limit=5000`.
 * Returns closes and bar timestamps for axis labeling, or null on failure.
 *
 * Concurrent calls for the same symbol share one fetch (see `intradayBarsInFlight`).
 */
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

/**
 * Fetch previous close for a single symbol.
 *
 * Uses `/v2/aggs/ticker/{symbol}/prev?adjusted=true`.
 * Returns the previous close price, or null when unavailable.
 */
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
