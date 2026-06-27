import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import {
	getIntradaySparklineFromCache,
	getSevenDaySparklineFromCache,
} from "../market-notifications/price-history-cache";
import {
	downsampleEvenly,
	type SparklineMap,
	type SparklineWindow,
	toSparkline,
} from "../messaging/sparkline";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { getUsMarketClosureInfoForInstant } from "../time/market-calendar";
import {
	fetchDailyCloses,
	fetchIntradayBars,
	fetchPrevDayBar,
	fetchSnapshotQuotes,
	marketDataFetch,
} from "./massive";

// Re-exported so messaging-layer consumers don't reach into `providers/massive`
// directly — `price-fetcher` is the public abstraction over the snapshot API.
export { NO_SESSION_TRADE, type NoSessionTrade } from "./massive";

interface AssetPrice {
	price: number;
	changePercent: number;
	timestamp?: number | null;
	/** Yesterday's close (Massive `prevDay.c`). */
	prevClose?: number | null;
}

/** Quote fields used by movement alerts and snapshot persistence. */
export interface ExtendedAssetQuote extends AssetPrice {
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

/** Map of simple price quotes keyed by symbol. `null` = ticker missing (fetch fail / no live trade). */
export type AssetPriceMap = Map<string, AssetPrice | null>;
/** Map of extended quotes keyed by symbol. */
export type ExtendedQuoteMap = Map<string, ExtendedAssetQuote | null>;

/**
 * Price map plus a side-channel set of symbols whose ticker entry was
 * returned by Massive but had no live trade in the current session.
 *
 * Only the scheduled-notification renderer consumes `noSessionTrade` (to
 * show "no pre-market trades" instead of the generic "price unavailable").
 * Movement alerts, snapshot persistence, the daily digest, etc. don't
 * distinguish — a `null` entry in `prices` is treated the same regardless
 * of cause, so they use `fetchAssetPrices` / `fetchExtendedQuotes` directly.
 */
export interface AssetPricesWithSessionState {
	prices: AssetPriceMap;
	noSessionTrade: Set<string>;
}

export type MarketSession = "pre" | "regular" | "after" | "closed";

export type SparklineCacheOptions = {
	supabase: SupabaseAdminClient;
	timezone?: string;
	use24HourTime?: boolean;
};

export function parseMarketSession(payload: unknown): MarketSession {
	if (typeof payload !== "object" || payload === null) {
		rootLogger.warn("Massive market-status payload is not an object", { payload });
		return "closed";
	}

	const record = payload as Record<string, unknown>;
	const market = typeof record.market === "string" ? record.market : null;

	if (market === null) {
		rootLogger.warn("Massive market-status payload missing 'market' field", { payload });
		return "closed";
	}

	// Authoritative: market === "open" means regular session, regardless of other flags.
	if (market === "open") return "regular";

	const earlyHours = record.earlyHours === true;
	const afterHours = record.afterHours === true;

	// Corrupt-payload guard: only fires when market !== "open" AND both flags set.
	if (earlyHours && afterHours) {
		rootLogger.warn("Massive market-status returned both earlyHours and afterHours true", {
			payload,
		});
		return "closed";
	}

	if (earlyHours) return "pre";
	if (afterHours) return "after";
	return "closed";
}

export async function getCurrentMarketSession(): Promise<MarketSession> {
	const [data, closure] = await Promise.all([
		marketDataFetch("/v1/marketstatus/now", {}, "market-status"),
		getUsMarketClosureInfoForInstant(DateTime.utc()),
	]);
	// Calendar-aware override: on US half-days, the regular session ends at the
	// early close (typically 1pm ET) and there is NO after-hours session.
	// Massive's `/v1/marketstatus/now` half-day behavior is undocumented; if it
	// flips to `afterHours: true` in the dead zone we'd otherwise classify the
	// session as "after" and fire scheduled notifications with a stale baseline.
	// The calendar tells us this is a half-day-after-close — force "closed".
	if (closure?.reason === "half-day-after-close") {
		return "closed";
	}
	return parseMarketSession(data);
}

/**
 * Fetch quotes for a list of symbols and return a map keyed by symbol.
 *
 * `session` is required so the prev-day-bar fallback in
 * `fillSnapshotMissesWithPrevDayBar` reuses the session the orchestrator
 * already fetched at the top of its loop — avoiding a second
 * `/v1/marketstatus/now` round-trip per cron tick. Spec: "Session is
 * fetched once at the top of the user-processing loop and passed as a
 * parameter to anything downstream."
 */
export async function fetchAssetPrices(
	symbols: string[],
	session: MarketSession,
): Promise<AssetPriceMap> {
	const snapshot = await fetchSnapshotQuotes(symbols, session);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
	return narrowSnapshotToPriceMap(snapshot);
}

/**
 * Like `fetchAssetPrices`, but also returns the set of symbols Massive
 * recognized but had no live trade for in the current session. Used by the
 * scheduled-notification renderer to show "no pre-market trades" instead
 * of the generic "price unavailable" for illiquid tickers.
 */
export async function fetchAssetPricesWithSessionState(
	symbols: string[],
	session: MarketSession,
): Promise<AssetPricesWithSessionState> {
	const snapshot = await fetchSnapshotQuotes(symbols, session);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
	return splitSnapshotByNoSessionTrade(snapshot);
}

function narrowSnapshotToPriceMap<T extends AssetPrice>(
	snapshot: Map<string, T | "no_session_trade" | null>,
): Map<string, T | null> {
	const result = new Map<string, T | null>();
	for (const [symbol, entry] of snapshot) {
		result.set(symbol, entry === "no_session_trade" ? null : entry);
	}
	return result;
}

function splitSnapshotByNoSessionTrade<T extends AssetPrice>(
	snapshot: Map<string, T | "no_session_trade" | null>,
): { prices: Map<string, T | null>; noSessionTrade: Set<string> } {
	const prices = new Map<string, T | null>();
	const noSessionTrade = new Set<string>();
	for (const [symbol, entry] of snapshot) {
		if (entry === "no_session_trade") {
			prices.set(symbol, null);
			noSessionTrade.add(symbol);
		} else {
			prices.set(symbol, entry);
		}
	}
	return { prices, noSessionTrade };
}

/**
 * Fetch extended quotes for symbols (day high/low/open/prevClose + volume).
 *
 * `session` is required for the same reason as `fetchAssetPrices` —
 * single source of truth, no redundant API calls.
 */
export async function fetchExtendedQuotes(
	symbols: string[],
	session: MarketSession,
): Promise<ExtendedQuoteMap> {
	const snapshot = await fetchSnapshotQuotes(symbols, session);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
	return narrowSnapshotToPriceMap(snapshot) as ExtendedQuoteMap;
}

/**
 * Fill snapshot misses with Massive's previous-day bar.
 *
 * **Session guard**: any active session (pre / regular / after) leaves the
 * miss as null — serving yesterday's bar labeled as "current price" during a
 * trading session would mislead users whose alerts compare against live price.
 * Only when the market is fully closed do we fall back to the prev-day bar,
 * which is the freshest data available.
 *
 * On a fully-closed market, `"no_session_trade"` (Massive recognized the symbol
 * but no session-bound trade exists) is semantically equivalent to a miss —
 * there is no current session that could have produced a trade — so those
 * entries get the prev-day-bar fallback too. On active sessions
 * `"no_session_trade"` keeps its illiquid-in-this-session meaning and we don't
 * backfill (those tickers are intentionally surfaced as "no pre/after-market
 * trade" rather than as stale prev-day data).
 *
 * When the prev-day-bar fetch returns null or throws on a closed session, the
 * entry is overwritten with `null` (not left as `"no_session_trade"`). This
 * preserves the page-worthy "prices missing" signal in `splitSnapshotByNoSessionTrade`
 * downstream — a delisted ticker on a Saturday should surface as a real miss,
 * not be bucketed as "expected illiquid in current session" (there is no
 * current session).
 *
 * Fetches run in parallel with a small worker pool (mirrors
 * `fetchSparklines`), bounding Massive load when many tickers need backfilling.
 */
export async function fillSnapshotMissesWithPrevDayBar(
	symbols: string[],
	snapshot: Map<string, unknown>,
	session: MarketSession,
): Promise<void> {
	if (session !== "closed") {
		// Active session: leave snapshot misses as null rather than serving stale data.
		// Downstream callers already handle null quotes gracefully.
		return;
	}

	const missing = symbols.filter((symbol) => {
		const entry = snapshot.get(symbol);
		return entry === null || entry === "no_session_trade";
	});
	if (missing.length === 0) return;

	const CONCURRENCY = 5;
	const queue = [...missing];

	async function worker(): Promise<void> {
		while (true) {
			const symbol = queue.shift();
			if (symbol === undefined) break;
			try {
				const bar = await fetchPrevDayBar(symbol);
				// On a closed session, an entry that started as "no_session_trade"
				// but couldn't be backfilled (delisted / OTC / vendor outage on the
				// prev-bar endpoint) gets overwritten with null. Otherwise
				// `splitSnapshotByNoSessionTrade` would bucket it as "expected
				// illiquid" and the daily-digest classifier would suppress the
				// page-worthy "prices missing" error — there's no session for it
				// to be illiquid in.
				snapshot.set(symbol, bar);
			} catch (error) {
				snapshot.set(symbol, null);
				rootLogger.error("Prev-day-bar fallback failed", { symbol }, createErrorForLogging(error));
			}
		}
	}

	const workers: Promise<void>[] = [];
	for (let i = 0; i < Math.min(CONCURRENCY, missing.length); i++) {
		workers.push(worker());
	}
	await Promise.all(workers);
}

/** Fetch 7-point sparklines for the last ~week of closes. */
export async function fetchSparklines(
	symbols: string[],
	cacheOptions?: SparklineCacheOptions,
): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	const todayET = new Date().toLocaleDateString("en-CA", {
		timeZone: US_MARKET_TIMEZONE,
	});
	const to = todayET;
	const from = new Date(new Date(`${todayET}T12:00:00Z`).getTime() - 9 * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	const CONCURRENCY = 5;
	const queue = [...symbols];
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

	for (let i = 0; i < Math.min(CONCURRENCY, symbols.length); i++) {
		pending.push(worker());
	}
	await Promise.all(pending);

	if (cacheOptions?.supabase) {
		for (const symbol of symbols) {
			if (result.get(symbol)) continue;
			const cached = await getSevenDaySparklineFromCache(cacheOptions.supabase, symbol, {
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
 * notifications (derived from price vs prevDay.c in `parseSnapshotTicker`),
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
 * `values` holds the full series for SVG rendering; `ascii` is downsampled to
 * `SMS_SPARKLINE_LENGTH` blocks so SMS bodies stay within their UCS-2 budget.
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
