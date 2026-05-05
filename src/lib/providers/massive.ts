import { setTimeout as realDelay } from "node:timers/promises";
import { US_MARKET_TIMEZONE } from "../constants";
import { requireEnv } from "../db/env";
import { rootLogger } from "../logging";
import { finnhubFetch } from "./finnhub";

type DeliveryChannel = "sms" | "email";

/* =============
Types
============= */

export interface ProviderResult<T> {
	data: T[];
	failed: boolean;
}

interface EarningsEvent {
	ticker: string;
	date: string; // YYYY-MM-DD
	time: string | null; // UTC 24h format
	epsEstimate: number | null;
	revenueEstimate: number | null;
}

interface DividendEvent {
	ticker: string;
	exDividendDate: string; // YYYY-MM-DD
	cashAmount: number;
	currency: string;
	payDate: string | null;
	frequency: number | null; // 1=annual, 2=semi, 4=quarterly, 12=monthly
}

interface SplitEvent {
	ticker: string;
	executionDate: string; // YYYY-MM-DD
	splitFrom: number; // e.g. 1
	splitTo: number; // e.g. 10
	adjustmentType: string; // forward_split, reverse_split, stock_dividend
}

interface IpoEvent {
	ticker: string;
	listingDate: string; // YYYY-MM-DD
	issuerName: string | null;
	securityType: string | null;
}

/* =============
Constants
============= */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 25_000;

/* =============
Helpers
============= */

const MASSIVE_BASE_URL = "https://api.massive.com";

function getMassiveApiKey(): string {
	return requireEnv("MASSIVE_API_KEY");
}

function computeRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
	if (retryAfterMs !== null) {
		return Math.min(retryAfterMs, 60_000);
	}
	const base = RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * base * 0.5;
	return base + jitter;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1_000;
	}
	return null;
}

/**
 * Low-level Massive fetch wrapper with retries, rate-limit handling, and timeouts.
 *
 * Returns `null` when the request ultimately fails.
 */
export async function marketDataFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
	logContext?: Record<string, unknown>,
): Promise<unknown> {
	const apiKey = getMassiveApiKey();

	const query = new URLSearchParams({ ...params, apiKey });
	const url = `${MASSIVE_BASE_URL}${endpoint}?${query.toString()}`;

	// Per-attempt failures log at warn (transient — next retry may recover).
	// Final-attempt failures escalate: 429 stays info (rate limiting is an
	// expected rejection), non-429 errors and exception paths log at error so
	// ErrorLogAlarm catches Massive outages that take the price feed down.
	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;

		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (response.status === 429) {
				const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
				const rateLimitContext = {
					endpoint,
					attempt,
					status: 429,
					...logContext,
				};
				if (!isLastAttempt) {
					rootLogger.warn(`Massive ${label} rate limited (429)`, rateLimitContext);
					await realDelay(computeRetryDelayMs(attempt, retryAfterMs));
					continue;
				}
				rootLogger.info(`Massive ${label} rate limited (429)`, rateLimitContext);
				return null;
			}

			if (!response.ok) {
				let apiStatus: string | null = null;
				try {
					const payload = (await response.json()) as Record<string, unknown>;
					apiStatus = typeof payload.status === "string" ? payload.status : null;
				} catch {
					// Ignore malformed/non-JSON error bodies.
				}

				const apiErrorContext = {
					endpoint,
					attempt,
					status: response.status,
					apiStatus,
					...logContext,
				};
				if (isLastAttempt) {
					rootLogger.error(`Massive ${label} exhausted retries`, apiErrorContext);
					return null;
				}
				rootLogger.warn(`Massive ${label} API error`, apiErrorContext);
				await realDelay(computeRetryDelayMs(attempt, null));
				continue;
			}

			return await response.json();
		} catch (error) {
			const requestErrorContext = {
				endpoint,
				attempt,
				error: error instanceof Error ? error.message : String(error),
				...logContext,
			};
			if (isLastAttempt) {
				rootLogger.error(
					`Massive ${label} exhausted retries`,
					requestErrorContext,
					error instanceof Error ? error : new Error(String(error)),
				);
				return null;
			}
			rootLogger.warn(`Massive ${label} request failed`, requestErrorContext);
			await realDelay(computeRetryDelayMs(attempt, null));
		}
	}

	return null;
}

async function fetchFinnhubEarnings(
	from: string,
	to: string,
): Promise<ProviderResult<EarningsEvent>> {
	const toNumberOrNull = (value: unknown): number | null =>
		typeof value === "number" && Number.isFinite(value) ? value : null;
	const toStringOrNull = (value: unknown): string | null =>
		typeof value === "string" && value.trim() !== "" ? value : null;

	const data = await finnhubFetch("/calendar/earnings", { from, to }, "earnings-calendar");
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const raw = (data as Record<string, unknown>).earningsCalendar;
	if (!Array.isArray(raw)) return { data: [], failed: false };

	const events: EarningsEvent[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		const ticker = toStringOrNull(row.symbol);
		const dateRaw = toStringOrNull(row.date);
		if (!ticker || !dateRaw) continue;

		const date = dateRaw.slice(0, 10);
		const key = `${ticker}|${date}`;
		if (seen.has(key)) continue;
		seen.add(key);

		events.push({
			ticker,
			date,
			time: toStringOrNull(row.hour),
			epsEstimate: toNumberOrNull(row.epsEstimate),
			revenueEstimate: toNumberOrNull(row.revenueEstimate),
		});
	}

	return { data: events, failed: false };
}

/* =============
Fetchers
============= */

/**
 * Fetch all earnings events for a date range (market-wide).
 */
export async function fetchEarnings(
	from: string,
	to: string,
): Promise<ProviderResult<EarningsEvent>> {
	// Use Finnhub as the canonical earnings feed to avoid partner entitlement issues on Massive.
	return fetchFinnhubEarnings(from, to);
}

/**
 * Fetch all ex-dividend events for a date range (market-wide).
 */
export async function fetchDividends(
	from: string,
	to: string,
): Promise<ProviderResult<DividendEvent>> {
	const data = await marketDataFetch(
		"/v3/reference/dividends",
		{
			"ex_dividend_date.gte": from,
			"ex_dividend_date.lte": to,
			limit: "1000",
		},
		"dividends",
	);
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as Record<string, unknown>).ticker === "string" &&
					typeof (item as Record<string, unknown>).ex_dividend_date === "string" &&
					typeof (item as Record<string, unknown>).cash_amount === "number",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				exDividendDate: item.ex_dividend_date as string,
				cashAmount: item.cash_amount as number,
				currency: typeof item.currency === "string" ? item.currency : "USD",
				payDate: typeof item.pay_date === "string" ? item.pay_date : null,
				frequency: typeof item.frequency === "number" ? item.frequency : null,
			})),
		failed: false,
	};
}

/**
 * Fetch all stock splits for a date range (market-wide).
 */
export async function fetchSplits(from: string, to: string): Promise<ProviderResult<SplitEvent>> {
	const data = await marketDataFetch(
		"/v3/reference/splits",
		{
			"execution_date.gte": from,
			"execution_date.lte": to,
			limit: "1000",
		},
		"splits",
	);
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as Record<string, unknown>).ticker === "string" &&
					typeof (item as Record<string, unknown>).execution_date === "string" &&
					typeof (item as Record<string, unknown>).split_from === "number" &&
					typeof (item as Record<string, unknown>).split_to === "number",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				executionDate: item.execution_date as string,
				splitFrom: item.split_from as number,
				splitTo: item.split_to as number,
				adjustmentType:
					typeof item.adjustment_type === "string" ? item.adjustment_type : "forward_split",
			})),
		failed: false,
	};
}

/**
 * Fetch upcoming IPO events for a date range (market-wide).
 */
export async function fetchIpos(from: string, to: string): Promise<ProviderResult<IpoEvent>> {
	const data = await marketDataFetch(
		"/vX/reference/ipos",
		{
			"listing_date.gte": from,
			"listing_date.lte": to,
			limit: "1000",
		},
		"ipos",
	);
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as Record<string, unknown>).ticker === "string" &&
					typeof (item as Record<string, unknown>).listing_date === "string",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				listingDate: item.listing_date as string,
				issuerName: typeof item.issuer_name === "string" ? item.issuer_name : null,
				securityType: typeof item.security_type === "string" ? item.security_type : null,
			})),
		failed: false,
	};
}

/* =============
Daily Aggregates
============= */

/**
 * Extract closing prices from a Polygon/Massive bars API response.
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
}

/**
 * Extract closing prices and bar timestamps from a Polygon/Massive bars API response.
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

	// Expose per-bar timestamps when we have any valid t; use null for bars lacking t
	return {
		closes,
		timestamps: startTimestamp !== null ? timestamps : null,
		startTimestamp,
		endTimestamp,
	};
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
			bars.push({ open: o, high: h, low: l, close: c, volume: v });
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

/**
 * Fetch intraday 5-minute closing prices for a single symbol (today, ET timezone).
 *
 * Uses `/v2/aggs/ticker/{symbol}/range/5/minute/{today}/{today}?sort=asc&limit=5000`.
 * Returns closes and bar timestamps for axis labeling, or null on failure.
 */
export async function fetchIntradayBars(symbol: string): Promise<IntradayBarsResult | null> {
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

/* =============
Snapshot Quotes
============= */

/**
 * Snapshot ticker shape from Massive `/v2/snapshot/locale/us/markets/stocks/tickers`.
 */
interface SnapshotTicker {
	ticker: string;
	todaysChangePerc?: number;
	updated?: number; // nanoseconds
	day?: {
		o: number;
		h: number;
		l: number;
		c: number;
		v: number;
	};
	prevDay?: {
		c: number;
	};
}

interface SnapshotQuote {
	price: number;
	changePercent: number;
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

function parseSnapshotTicker(t: SnapshotTicker): SnapshotQuote | null {
	const price = t.day?.c;
	if (typeof price !== "number" || !Number.isFinite(price) || price === 0) return null;

	let changePercent = t.todaysChangePerc;
	if (typeof changePercent !== "number" || !Number.isFinite(changePercent)) return null;

	// When market is closed, todaysChangePerc is 0 because there are no trades
	// today. Fall back to the last trading day's change (day.c vs prevDay.c)
	// so notifications don't confusingly show +(0.00%).
	const prevClose = t.prevDay?.c;
	if (
		changePercent === 0 &&
		typeof prevClose === "number" &&
		Number.isFinite(prevClose) &&
		prevClose !== 0 &&
		price !== prevClose
	) {
		changePercent = ((price - prevClose) / prevClose) * 100;
	}

	const numPrice = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null;
	const numVolume = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

	return {
		price,
		changePercent,
		dayHigh: numPrice(t.day?.h),
		dayLow: numPrice(t.day?.l),
		dayOpen: numPrice(t.day?.o),
		prevClose: numPrice(t.prevDay?.c),
		// Massive `updated` is in nanoseconds — convert to seconds for consistency
		timestamp:
			typeof t.updated === "number" && Number.isFinite(t.updated)
				? Math.floor(t.updated / 1_000_000_000)
				: null,
		volume: numVolume(t.day?.v),
	};
}

/**
 * Batch-fetch snapshot quotes for a list of symbols via a single Massive API call.
 *
 * Uses `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=A,B,C`.
 * Returns a Map keyed by symbol; missing/invalid tickers map to `null`.
 */
export async function fetchSnapshotQuotes(
	symbols: string[],
): Promise<Map<string, SnapshotQuote | null>> {
	const result = new Map<string, SnapshotQuote | null>();
	if (symbols.length === 0) return result;

	// Pre-fill with null so callers always see every requested symbol
	for (const s of symbols) result.set(s, null);

	const data = await marketDataFetch(
		"/v2/snapshot/locale/us/markets/stocks/tickers",
		{ tickers: symbols.join(",") },
		"snapshot-quotes",
		{ tickerCount: symbols.length },
	);

	if (typeof data !== "object" || data === null) return result;

	const tickers = (data as Record<string, unknown>).tickers;
	if (!Array.isArray(tickers)) return result;

	for (const raw of tickers) {
		if (typeof raw !== "object" || raw === null) continue;
		const t = raw as SnapshotTicker;
		if (typeof t.ticker !== "string") continue;

		const quote = parseSnapshotTicker(t);
		if (quote) {
			result.set(t.ticker, quote);
		}
	}

	return result;
}

/* =============
Top Movers (market-wide gainers / losers)
============= */

export interface TopMover {
	ticker: string;
	price: number;
	changePercent: number;
}

/**
 * Fetch market-wide top gainers or losers for the current session.
 *
 * Uses `/v2/snapshot/locale/us/markets/stocks/{gainers|losers}`, which
 * returns tickers already sorted by `todaysChangePerc`. Sub-$5 names are
 * filtered out to cut penny-stock / warrant noise, and tickers showing
 * `todaysChangePerc === 0` are skipped — `parseSnapshotTicker` would
 * otherwise fall back to the prior session's change, which misrepresents
 * why a ticker appeared on today's movers list.
 *
 * Returns up to `limit` results. Fewer may be returned if the upstream
 * response is small or most tickers fail the price filter.
 */
export async function fetchTopMovers(
	direction: "gainers" | "losers",
	options?: { limit?: number; minPrice?: number },
): Promise<TopMover[]> {
	const limit = options?.limit ?? 5;
	const minPrice = options?.minPrice ?? 5;

	const data = await marketDataFetch(
		`/v2/snapshot/locale/us/markets/stocks/${direction}`,
		{},
		`top-${direction}`,
	);
	if (typeof data !== "object" || data === null) return [];

	const tickers = (data as Record<string, unknown>).tickers;
	if (!Array.isArray(tickers)) return [];

	const movers: TopMover[] = [];
	for (const raw of tickers) {
		if (typeof raw !== "object" || raw === null) continue;
		const t = raw as SnapshotTicker;
		if (typeof t.ticker !== "string") continue;

		// Use the raw todaysChangePerc directly rather than parseSnapshotTicker's
		// prev-day fallback: on the gainers/losers endpoint a 0% entry means the
		// ticker genuinely hasn't moved today, not that the market is closed.
		const changePercent = t.todaysChangePerc;
		if (
			typeof changePercent !== "number" ||
			!Number.isFinite(changePercent) ||
			changePercent === 0
		) {
			continue;
		}

		const price = t.day?.c;
		if (typeof price !== "number" || !Number.isFinite(price) || price === 0) {
			continue;
		}
		if (price < minPrice) continue;

		movers.push({ ticker: t.ticker, price, changePercent });
		if (movers.length >= limit) break;
	}

	return movers;
}

/* =============
Previous-day bar + reference lookup
============= */

/**
 * Full previous-day bar returned by `fetchPrevDayBar`. Shape is compatible
 * with `ExtendedAssetQuote` so callers can drop it into snapshot maps.
 * `changePercent` is always 0 for this path — it represents stale data
 * from the last trading day, not today's change.
 */
export interface PrevDayBar {
	price: number;
	changePercent: number;
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

/**
 * Fetch the previous-day OHLCV bar for a single symbol.
 *
 * Uses `/v2/aggs/ticker/{symbol}/prev?adjusted=true` — same endpoint as
 * `fetchPrevClose`, but returns the full bar so snapshot-miss fallbacks can
 * populate dayHigh/Low/Open/volume instead of null-filling them.
 *
 * Returns `null` when the symbol has no prev-day data or the response shape
 * is unexpected.
 */
export async function fetchPrevDayBar(symbol: string): Promise<PrevDayBar | null> {
	const data = await marketDataFetch(
		`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`,
		{ adjusted: "true" },
		"prev-day-bar",
	);
	if (typeof data !== "object" || data === null) return null;

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results) || results.length === 0) return null;

	const first = results[0];
	if (typeof first !== "object" || first === null) return null;
	const row = first as Record<string, unknown>;

	const close = row.c;
	if (typeof close !== "number" || !Number.isFinite(close) || close === 0) {
		return null;
	}

	const numPrice = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null;
	const numVolume = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
	const numTimestamp = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

	return {
		price: close,
		changePercent: 0,
		dayHigh: numPrice(row.h),
		dayLow: numPrice(row.l),
		dayOpen: numPrice(row.o),
		// `prevClose` would require a second /aggs call (the close of the day
		// before this bar's day). Leave it null rather than duplicating `price`
		// — the live snapshot path uses prevClose to show "yesterday's close
		// vs today's price"; reusing `close` here would display the same
		// number twice to end users.
		prevClose: null,
		timestamp: numTimestamp(row.t),
		volume: numVolume(row.v),
	};
}

/**
 * Authoritative delisting record for a single symbol, as returned by
 * Massive's reference-tickers endpoint.
 */
export interface TickerReferenceResult {
	symbol: string;
	active: false;
	/** YYYY-MM-DD — always present in a `delisted` status. */
	delistedUtc: string;
	primaryExchange: string | null;
	name: string | null;
}

/**
 * Discriminated result of a single reference lookup:
 * - `delisted` — Massive explicitly returned `active: false` with a `delisted_utc`.
 * - `unknown` — Massive returned no results, OR a result without the strict
 *   delisting fields. Treat as "still listed or not in Massive." Must NOT
 *   be interpreted as a delisting signal (OTC/SPAC pre-listing tickers fall
 *   into this bucket).
 * - `provider_error` — Transient fetch failure after retries. Caller should
 *   skip this symbol without changing state and retry on the next run.
 */
export type TickerReferenceStatus =
	| { status: "delisted"; result: TickerReferenceResult }
	| { status: "unknown"; symbol: string }
	| { status: "provider_error"; symbol: string };

/**
 * Look up a single symbol in Massive's reference-tickers endpoint filtered
 * to `active=false`.
 *
 * Uses `/v3/reference/tickers?ticker={symbol}&active=false&limit=1`. When
 * the ticker is still active (or unknown to Massive), the endpoint returns
 * an empty `results` array, and this function yields `{status: "unknown"}`.
 *
 * Strict validation: only returns `{status: "delisted"}` when the response
 * row has `active === false` AND a `delisted_utc` string of length ≥ 10.
 * Everything else is `unknown` — never infer a delisting from absence.
 */
export async function fetchTickerReference(symbol: string): Promise<TickerReferenceStatus> {
	const data = await marketDataFetch(
		"/v3/reference/tickers",
		{ ticker: symbol, active: "false", limit: "1" },
		"ticker-reference",
		{ symbol },
	);

	if (data === null) return { status: "provider_error", symbol };
	if (typeof data !== "object") return { status: "unknown", symbol };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results) || results.length === 0) {
		return { status: "unknown", symbol };
	}

	const first = results[0];
	if (typeof first !== "object" || first === null) {
		return { status: "unknown", symbol };
	}
	const row = first as Record<string, unknown>;

	if (row.active !== false) return { status: "unknown", symbol };

	const rawDelistedUtc = row.delisted_utc;
	if (typeof rawDelistedUtc !== "string" || rawDelistedUtc.length < 10) {
		return { status: "unknown", symbol };
	}

	return {
		status: "delisted",
		result: {
			symbol,
			active: false,
			delistedUtc: rawDelistedUtc.slice(0, 10),
			primaryExchange: typeof row.primary_exchange === "string" ? row.primary_exchange : null,
			name: typeof row.name === "string" ? row.name : null,
		},
	};
}

/**
 * Concurrent reference lookup for multiple symbols with bounded parallelism.
 *
 * Returns one status per input symbol; order is not guaranteed.
 * Mirrors the worker-pool pattern used by `fetchSparklines` in
 * `src/lib/providers/price-fetcher.ts`.
 */
export async function fetchTickerReferences(
	symbols: string[],
	concurrency = 5,
): Promise<TickerReferenceStatus[]> {
	if (symbols.length === 0) return [];
	const results: TickerReferenceStatus[] = [];
	const queue = [...symbols];

	async function worker(): Promise<void> {
		while (true) {
			const next = queue.shift();
			if (next === undefined) return;
			results.push(await fetchTickerReference(next));
		}
	}

	const workerCount = Math.min(concurrency, symbols.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

/* =============
Formatting
============= */

/**
 * Format a revenue estimate compactly for display.
 */
function formatRevenue(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${Math.round(abs / 1_000_000)}M`;
	return abs.toLocaleString("en-US");
}

/**
 * Format a split ratio as a human-readable string (e.g. "10:1" or "1:5 reverse").
 */
function formatSplitRatio(splitFrom: number, splitTo: number, adjustmentType: string): string {
	const isReverse = adjustmentType === "reverse_split" || splitTo < splitFrom;
	if (isReverse) {
		return `${splitFrom}:${splitTo} reverse`;
	}
	return `${splitTo}:${splitFrom}`;
}

/** Map Massive dividend frequency codes to labels. */
const FREQUENCY_LABELS: Record<number, string> = {
	1: "annual",
	2: "semi-annual",
	4: "quarterly",
	12: "monthly",
};

/**
 * Format asset events from the DB into a channel-appropriate text block.
 *
 * Events are grouped by type (earnings, dividends, splits, IPOs).
 * Returns `null` when there are no events.
 */
/**
 * Format a countdown label for an event based on `daysUntil`.
 *
 * - 0 → "today"
 * - 1 → "tomorrow"
 * - 2+ → "in N days (MM-DD)"
 * - undefined → MM-DD (backward compatible)
 */
function formatDateLabel(eventDate: string, daysUntil: number | undefined): string {
	if (daysUntil === undefined) {
		return eventDate.slice(5); // MM-DD
	}
	if (daysUntil === 0) return "today";
	if (daysUntil === 1) return "tomorrow";
	return `in ${daysUntil} days (${eventDate.slice(5)})`;
}

/**
 * Format asset events from the DB into a channel-appropriate text block.
 *
 * Events are grouped by type (earnings, dividends, splits, IPOs).
 * Returns `null` when there are no events.
 *
 * Each event may include an optional `daysUntil` field for countdown display:
 * - 0 → "today", 1 → "tomorrow", 2+ → "in N days (MM-DD)"
 * - When absent, existing MM-DD format is used (backward compatible).
 */
export function formatAssetEventsSection(
	events: Array<{
		symbol: string;
		event_type: "earnings" | "dividend" | "split" | "ipo";
		event_date: string;
		data: Record<string, unknown>;
		daysUntil?: number;
	}>,
	channel: DeliveryChannel,
): {
	earnings: string | null;
	dividends: string | null;
	splits: string | null;
	ipos: string | null;
} {
	const earningsLines: string[] = [];
	const dividendLines: string[] = [];
	const splitLines: string[] = [];
	const ipoLines: string[] = [];

	for (const event of events) {
		const dateLabel = formatDateLabel(event.event_date, event.daysUntil);

		if (event.event_type === "earnings") {
			const time = event.data.time as string | null;
			const timeLabel = time ? ` (${time})` : "";
			if (channel === "sms") {
				earningsLines.push(`${event.symbol}: earnings ${dateLabel}${timeLabel}`);
			} else {
				const estimates: string[] = [];
				const eps = event.data.epsEstimate as number | null;
				const rev = event.data.revenueEstimate as number | null;
				if (eps !== null && eps !== undefined) estimates.push(`EPS est. $${eps.toFixed(2)}`);
				if (rev !== null && rev !== undefined) estimates.push(`Rev est. $${formatRevenue(rev)}`);
				const estimateStr = estimates.length > 0 ? ` — ${estimates.join(", ")}` : "";
				earningsLines.push(`${event.symbol}: earnings ${dateLabel}${timeLabel}${estimateStr}`);
			}
		} else if (event.event_type === "dividend") {
			const amount = event.data.cashAmount as number;
			const payDate = event.data.payDate as string | null;
			if (channel === "sms") {
				dividendLines.push(`${event.symbol}: ex-div ${dateLabel} $${amount.toFixed(2)}`);
			} else {
				const payStr = payDate ? ` (pays ${payDate.slice(5)})` : "";
				const freq = event.data.frequency as number | null;
				const freqStr = freq && FREQUENCY_LABELS[freq] ? `, ${FREQUENCY_LABELS[freq]}` : "";
				dividendLines.push(
					`${event.symbol}: ex-div ${dateLabel} — $${amount.toFixed(2)}/share${payStr}${freqStr}`,
				);
			}
		} else if (event.event_type === "split") {
			const splitFrom = event.data.splitFrom as number;
			const splitTo = event.data.splitTo as number;
			const adjType = event.data.adjustmentType as string;
			const ratio = formatSplitRatio(splitFrom, splitTo, adjType);
			if (channel === "sms") {
				splitLines.push(`${event.symbol}: split ${dateLabel} ${ratio}`);
			} else {
				const isReverse = adjType === "reverse_split" || splitTo < splitFrom;
				const numericRatio = isReverse ? `${splitFrom}:${splitTo}` : `${splitTo}:${splitFrom}`;
				const typeLabel = isReverse ? "reverse split" : "forward split";
				splitLines.push(`${event.symbol}: split ${dateLabel} — ${numericRatio} ${typeLabel}`);
			}
		} else if (event.event_type === "ipo") {
			const issuer = event.data.issuerName as string | undefined;
			if (channel === "sms") {
				ipoLines.push(`${event.symbol}: IPO ${dateLabel}`);
			} else {
				const issuerSuffix = issuer ? ` — ${issuer}` : "";
				ipoLines.push(`${event.symbol}: IPO ${dateLabel}${issuerSuffix}`);
			}
		}
	}

	return {
		earnings: earningsLines.length > 0 ? earningsLines.join("\n") : null,
		dividends: dividendLines.length > 0 ? dividendLines.join("\n") : null,
		splits: splitLines.length > 0 ? splitLines.join("\n") : null,
		ipos: ipoLines.length > 0 ? ipoLines.join("\n") : null,
	};
}
