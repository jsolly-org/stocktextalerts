import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import type { ExtendedAssetQuote, ExtendedQuoteMap, MarketSession, NoSessionTrade } from "../types";
import { NO_SESSION_TRADE } from "../types";
import { fetchPrevDayBar, fetchSnapshotQuotes } from "./quotes";
import type { AssetPricesWithSessionState } from "./types";

type SnapshotMap = Map<string, ExtendedAssetQuote | NoSessionTrade | null>;

/**
 * Fetch Massive snapshot quotes plus the set recognized with no trade attributable to
 * the requested active session. Closed-session misses are backfilled with previous-day bars.
 */
export async function fetchAssetPricesWithSessionState(
	symbols: string[],
	session: MarketSession,
): Promise<AssetPricesWithSessionState> {
	const snapshot = await fetchSnapshotQuotes(symbols, session);
	await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
	return splitSnapshotByNoSessionTrade(snapshot);
}

function splitSnapshotByNoSessionTrade(snapshot: SnapshotMap): {
	prices: ExtendedQuoteMap;
	noSessionTrade: Set<string>;
} {
	const prices: ExtendedQuoteMap = new Map();
	const noSessionTrade = new Set<string>();
	for (const [symbol, entry] of snapshot) {
		if (entry === NO_SESSION_TRADE) {
			prices.set(symbol, null);
			noSessionTrade.add(symbol);
		} else {
			prices.set(symbol, entry);
		}
	}
	return { prices, noSessionTrade };
}

/** Fetch extended Massive quotes, with previous-day fallback only while closed. */
export async function fetchExtendedQuotes(
	symbols: string[],
	session: MarketSession,
): Promise<ExtendedQuoteMap> {
	const { prices } = await fetchAssetPricesWithSessionState(symbols, session);
	return prices;
}

/**
 * Fill closed-session snapshot misses with Massive's previous-day aggregate.
 * Active sessions keep null and `NO_SESSION_TRADE` distinct so stale daily prices are
 * never labeled current.
 */
export async function fillSnapshotMissesWithPrevDayBar(
	symbols: string[],
	snapshot: SnapshotMap,
	session: MarketSession,
): Promise<void> {
	if (session !== "closed") {
		return;
	}

	const missing = symbols.filter((symbol) => {
		const entry = snapshot.get(symbol);
		return entry === null || entry === NO_SESSION_TRADE;
	});
	const queue = [...missing];
	const concurrency = 5;

	async function worker(): Promise<void> {
		for (;;) {
			const symbol = queue.shift();
			if (symbol === undefined) break;
			try {
				snapshot.set(symbol, await fetchPrevDayBar(symbol));
			} catch (error) {
				snapshot.set(symbol, null);
				rootLogger.error("Prev-day-bar fallback failed", { symbol }, createErrorForLogging(error));
			}
		}
	}

	const workers: Promise<void>[] = [];
	for (let index = 0; index < Math.min(concurrency, missing.length); index++) {
		workers.push(worker());
	}
	await Promise.all(workers);
}
