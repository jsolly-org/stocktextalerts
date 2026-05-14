import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import { downsampleEvenly, type SparklineMap, toSparkline } from "../messaging/sparkline";
import { isTest } from "../runtime/mode";
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
	if (isTest() && !isLiveMassiveEnabledInTests()) {
		return "regular";
	}
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

function isLiveMassiveEnabledInTests(): boolean {
	const enabled = process.env.LIVE_API_PROVIDERS ?? process.env.TEST_LIVE_PROVIDERS;
	if (!enabled) return false;
	return enabled
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.includes("massive");
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
	if (isTest() && !isLiveMassiveEnabledInTests()) {
		return new Map(
			symbols.map((s) => [
				s,
				{
					price: 150.0,
					changePercent: 1.25,
					prevClose: 148.5,
				},
			]),
		);
	}
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
	if (isTest() && !isLiveMassiveEnabledInTests()) {
		return {
			prices: await fetchAssetPrices(symbols, session),
			noSessionTrade: new Set(),
		};
	}
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
	if (isTest() && !isLiveMassiveEnabledInTests()) {
		return new Map(
			symbols.map((s) => [
				s,
				{
					price: 150.0,
					changePercent: 1.25,
					dayHigh: 152.0,
					dayLow: 148.0,
					dayOpen: 149.0,
					prevClose: 148.5,
					timestamp: Math.floor(Date.now() / 1000),
					volume: null,
				},
			]),
		);
	}
	const snapshot = await fetchSnapshotQuotes(symbols, session);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
	return narrowSnapshotToPriceMap(snapshot) as ExtendedQuoteMap;
}

/**
 * Fill snapshot misses with Massive's previous-day bar.
 *
 * Fires only for symbols Massive's live snapshot doesn't return. In practice
 * that means either (a) a legitimately delisted ticker that the daily sweep
 * hasn't cleaned up yet, or (b) a truly OTC ticker Massive's snapshot doesn't
 * cover (rare, but historically why the Finnhub fallback existed).
 *
 * **Session guard**: any active session (pre / regular / after) leaves the
 * miss as null — serving yesterday's bar labeled as "current price" during a
 * trading session would mislead users whose alerts compare against live price.
 * Only when the market is fully closed do we fall back to the prev-day bar,
 * which is the freshest data available.
 */
async function fillSnapshotMissesWithPrevDayBar(
	symbols: string[],
	snapshot: Map<string, unknown>,
	session: MarketSession,
): Promise<void> {
	const missing = symbols.filter((symbol) => snapshot.get(symbol) === null);
	if (missing.length === 0) return;

	if (session !== "closed") {
		// Any active session: leave misses as null rather than serving stale data.
		// Downstream callers already handle null quotes gracefully.
		return;
	}

	for (const symbol of missing) {
		try {
			const bar = await fetchPrevDayBar(symbol);
			if (bar !== null) {
				snapshot.set(symbol, bar);
			}
		} catch (error) {
			rootLogger.error(
				"Prev-day-bar fallback failed",
				{ symbol },
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}
}

/** Fetch 7-point sparklines for the last ~week of closes. */
export async function fetchSparklines(symbols: string[]): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	if (isTest() && !isLiveMassiveEnabledInTests()) {
		const stubValues = [1, 2, 3, 5, 7, 5, 3];
		for (const s of symbols) {
			result.set(s, { values: stubValues, ascii: "▁▂▃▅▇▅▃", window: "7-trading-days" });
		}
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
			rootLogger.error(
				"Sparkline fetch failed",
				{ symbol },
				error instanceof Error ? error : new Error(String(error)),
			);
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

	return result;
}

/**
 * Fetch intraday sparklines (today's 5-minute bars since open) for the given symbols.
 *
 * `values` holds the full series for SVG rendering; `ascii` is downsampled to
 * `SMS_SPARKLINE_LENGTH` blocks so SMS bodies stay within their UCS-2 budget.
 */
export async function fetchIntradaySparklines(symbols: string[]): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	if (isTest() && !isLiveMassiveEnabledInTests()) {
		const stubValues = [100, 100.5, 101.2, 100.8, 101.5, 102.1, 101.9, 102.4];
		for (const s of symbols) {
			result.set(s, {
				values: stubValues,
				ascii: toSparkline(downsampleEvenly(stubValues)),
				window: "intraday-since-open",
			});
		}
		return result;
	}

	const CONCURRENCY = 5;
	const queue = [...symbols];
	const pending: Promise<void>[] = [];

	async function processSymbol(symbol: string): Promise<void> {
		try {
			const bars = await fetchIntradayBars(symbol);
			const closes = bars?.closes;
			if (!closes || closes.length < 2) {
				result.set(symbol, null);
				return;
			}
			const ascii = toSparkline(downsampleEvenly(closes));
			result.set(symbol, ascii ? { values: closes, ascii, window: "intraday-since-open" } : null);
		} catch (error) {
			// Transient Massive failure — next scheduled invocation retries. `warn` keeps the
			// ErrorLogAlarm quiet on degraded-but-functional delivery (user still gets the
			// notification, just without this symbol's sparkline).
			rootLogger.warn(
				"Intraday sparkline fetch failed",
				{ symbol },
				error instanceof Error ? error : new Error(String(error)),
			);
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

	return result;
}
