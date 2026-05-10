import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import { type SparklineMap, toSparkline } from "../messaging/sparkline";
import { isTest } from "../runtime/mode";
import { getUsMarketClosureInfoForInstant } from "../time/market-calendar";
import {
	fetchDailyCloses,
	fetchPrevDayBar,
	fetchSnapshotQuotes,
	fetchTodaysRegularClose,
	marketDataFetch,
} from "./massive";

interface AssetPrice {
	price: number;
	changePercent: number;
	timestamp?: number | null;
	/** Yesterday's close (Massive `prevDay.c`). Used for session-aware change-% on extended hours. */
	prevClose?: number | null;
	/** Today's 4:00 PM ET regular-session close. Populated for after-hours sessions only. */
	dayCloseRegular?: number | null;
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

/** Map of simple price quotes keyed by symbol. */
export type AssetPriceMap = Map<string, AssetPrice | null>;
/** Map of extended quotes keyed by symbol. */
export type ExtendedQuoteMap = Map<string, ExtendedAssetQuote | null>;

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
					dayCloseRegular: null,
				},
			]),
		);
	}
	const snapshot = await fetchSnapshotQuotes(symbols);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
	return snapshot as AssetPriceMap;
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
	const snapshot = await fetchSnapshotQuotes(symbols);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
	return snapshot as ExtendedQuoteMap;
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

/**
 * Fetch today's regular-session close for a list of symbols (concurrency 5).
 *
 * Used by the after-hours scheduled-notification path so the renderer can
 * compute change-% vs. today's 4:00 PM ET close instead of yesterday's close.
 *
 * Map values are `null` for symbols whose daily bar isn't available (e.g.,
 * called before the regular close, on a non-trading day, or when Massive
 * returns no aggregate row for the symbol).
 */
export async function fetchTodaysRegularCloses(
	symbols: string[],
): Promise<Map<string, number | null>> {
	const result = new Map<string, number | null>();
	if (symbols.length === 0) return result;

	if (isTest() && !isLiveMassiveEnabledInTests()) {
		for (const s of symbols) result.set(s, 148.5);
		return result;
	}

	const CONCURRENCY = 5;
	const queue = [...symbols];

	async function worker(): Promise<void> {
		while (true) {
			const symbol = queue.shift();
			if (symbol === undefined) break;
			try {
				const close = await fetchTodaysRegularClose(symbol);
				result.set(symbol, close);
			} catch (error) {
				// Per-symbol catch falls back to null; renderer uses prev-day
				// baseline with †-footnote. This is the *expected* path before
				// 4:00 PM ET on every after-hours tick (no daily bar yet).
				// Spec: "day.close missing or zero in after-hours — fallback
				// applied; log at info." marketDataFetch already logs error
				// on retry exhaustion, so info here avoids double-noise.
				rootLogger.info("Today's regular-close fetch failed; falling back to prev-day baseline", {
					symbol,
					error: error instanceof Error ? error.message : String(error),
				});
				result.set(symbol, null);
			}
		}
	}

	const pending: Promise<void>[] = [];
	for (let i = 0; i < Math.min(CONCURRENCY, symbols.length); i++) {
		pending.push(worker());
	}
	await Promise.all(pending);
	return result;
}

/** Fetch 7-point sparklines for the last ~week of closes. */
export async function fetchSparklines(symbols: string[]): Promise<SparklineMap> {
	const result: SparklineMap = new Map();
	if (symbols.length === 0) return result;

	if (isTest() && !isLiveMassiveEnabledInTests()) {
		const stubValues = [1, 2, 3, 5, 7, 5, 3];
		for (const s of symbols) {
			result.set(s, { values: stubValues, ascii: "▁▂▃▅▇▅▃" });
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
			result.set(symbol, ascii ? { values: last7, ascii } : null);
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
