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

function titleSalient(card: PredictionMarketEventCard): boolean {
	// Ongoing lane requires a title-level identity match (not outcome-only).
	// Callers set matchKind/confidence; we approximate via symbol appearing in title
	// or an explicit highlight on any outcome.
	if (!card.symbol) return true;
	const sym = card.symbol.toLowerCase();
	if (card.title.toLowerCase().includes(sym)) return true;
	return card.outcomes.some((o) => o.highlighted === true);
}

/**
 * Per-asset selection — at most one prediction-market card per ticker:
 * - Prefer the soonest future close (reject expired / stale)
 * - Else the highest-volume undated ongoing card when title-salient and volume > 0
 * - Macro/curated markets are selected separately and are unaffected
 */
export function selectAssetEventCards(
	cards: readonly PredictionMarketEventCard[],
	options: { nowMs?: number } = {},
): PredictionMarketEventCard[] {
	const nowMs = options.nowMs ?? Date.now();

	const freshOpen = cards.filter(
		(c) =>
			c.outcomes.length > 0 &&
			isFresh(c.refreshedAt, nowMs) &&
			// Reject expired dated markets; undated stay eligible for ongoing lane.
			(c.closesAt === null || isFutureClose(c.closesAt, nowMs)),
	);

	const soonestDated = freshOpen
		.filter((c) => c.closesAt !== null)
		.sort((a, b) => Date.parse(a.closesAt ?? "") - Date.parse(b.closesAt ?? ""))[0];
	if (soonestDated) return [soonestDated];

	const bestOngoing = freshOpen
		.filter((c) => c.closesAt === null)
		.filter((c) => titleSalient(c))
		.filter((c) => c.volume > 0)
		.sort((a, b) => b.volume - a.volume)[0];

	return bestOngoing ? [bestOngoing] : [];
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
