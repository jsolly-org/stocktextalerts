import type { PredictionMarketEventCard } from "./types";
import { PREDICTION_MARKET_STALE_MS } from "./types";

function isFutureClose(closesAt: string | null, nowMs: number): boolean {
	if (!closesAt) return false;
	const ts = Date.parse(closesAt);
	return Number.isFinite(ts) && ts > nowMs;
}

function isFresh(refreshedAt: string, nowMs: number): boolean {
	const ts = Date.parse(refreshedAt);
	return Number.isFinite(ts) && nowMs - ts <= PREDICTION_MARKET_STALE_MS;
}

/** Next-day / session direction markets (e.g. "AAPL Up or Down on July 31?"). */
function isDailyDirectionMarket(card: PredictionMarketEventCard): boolean {
	return /\bup or down\b/i.test(card.title);
}

function soonestCloseFirst(a: PredictionMarketEventCard, b: PredictionMarketEventCard): number {
	const aTs = a.closesAt ? Date.parse(a.closesAt) : Number.POSITIVE_INFINITY;
	const bTs = b.closesAt ? Date.parse(b.closesAt) : Number.POSITIVE_INFINITY;
	if (aTs !== bTs) return aTs - bTs;
	return b.volume - a.volume;
}

/**
 * Per-asset selection — at most one card per ticker, and only daily up/down.
 * Price targets, KPIs, and company-subject markets are never shown.
 * Macro/curated markets are selected separately and are unaffected.
 */
export function selectAssetEventCards(
	cards: readonly PredictionMarketEventCard[],
	options: { nowMs?: number } = {},
): PredictionMarketEventCard[] {
	const nowMs = options.nowMs ?? Date.now();

	const bestDirection = cards
		.filter(
			(c) =>
				isDailyDirectionMarket(c) &&
				c.outcomes.length > 0 &&
				isFresh(c.refreshedAt, nowMs) &&
				(c.closesAt === null || isFutureClose(c.closesAt, nowMs)),
		)
		.sort(soonestCloseFirst)[0];

	return bestDirection ? [bestDirection] : [];
}

/**
 * Order asset cards by watchlist order (newest-first symbols), then within
 * each symbol keep selection order (at most one card per symbol).
 */
export function orderCardsByWatchlist(
	cardsBySymbol: ReadonlyMap<string, readonly PredictionMarketEventCard[]>,
	watchlistSymbolsNewestFirst: readonly string[],
): PredictionMarketEventCard[] {
	const out: PredictionMarketEventCard[] = [];
	for (const symbol of watchlistSymbolsNewestFirst) {
		const cards = cardsBySymbol.get(symbol);
		if (!cards || cards.length === 0) continue;
		out.push(...cards);
	}
	return out;
}
