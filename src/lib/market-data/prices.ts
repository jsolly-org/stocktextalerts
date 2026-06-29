import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import type { AssetPriceMap, ExtendedQuoteMap, MarketSession } from "../market-data-types";
import { fetchPrevDayBar, fetchSnapshotQuotes } from "./quotes";
import type { AssetPricesWithSessionState } from "./types";

interface AssetPrice {
	price: number;
	changePercent: number;
	timestamp?: number | null;
	prevClose?: number | null;
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
