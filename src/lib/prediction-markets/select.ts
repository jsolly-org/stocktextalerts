import type { PredictionMarketEventCard, PredictionMarketVenue } from "./types";
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

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const even = sorted.length % 2 === 0;
	const a = sorted[mid - 1];
	const b = sorted[mid];
	if (even && a !== undefined && b !== undefined) return (a + b) / 2;
	return b ?? a ?? null;
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
 * Per-asset selection:
 * - dated lane: up to 2 soonest future closes (reject expired)
 * - ongoing lane: up to 2 undated high-volume cards when title-salient and
 *   volume beats same-venue median of that asset's dated candidates
 * - no global cap
 */
export function selectAssetEventCards(
	cards: readonly PredictionMarketEventCard[],
	options: { nowMs?: number; datedLimit?: number; ongoingLimit?: number } = {},
): PredictionMarketEventCard[] {
	const nowMs = options.nowMs ?? Date.now();
	const datedLimit = options.datedLimit ?? 2;
	const ongoingLimit = options.ongoingLimit ?? 2;

	const freshOpen = cards.filter(
		(c) =>
			c.outcomes.length > 0 &&
			isFresh(c.refreshedAt, nowMs) &&
			// Reject expired dated markets; undated stay eligible for ongoing lane.
			(c.closesAt === null || isFutureClose(c.closesAt, nowMs)),
	);

	const dated = freshOpen
		.filter((c) => c.closesAt !== null)
		.sort((a, b) => Date.parse(a.closesAt ?? "") - Date.parse(b.closesAt ?? ""))
		.slice(0, datedLimit);

	const datedByVenue = new Map<PredictionMarketVenue, number[]>();
	for (const c of dated) {
		const list = datedByVenue.get(c.venue) ?? [];
		list.push(c.volume);
		datedByVenue.set(c.venue, list);
	}

	const ongoing = freshOpen
		.filter((c) => c.closesAt === null)
		.filter((c) => titleSalient(c))
		.filter((c) => {
			const med = median(datedByVenue.get(c.venue) ?? []);
			if (med === null) {
				// No dated baseline for this venue — require positive volume only.
				return c.volume > 0;
			}
			return c.volume > med;
		})
		.sort((a, b) => b.volume - a.volume)
		.slice(0, ongoingLimit);

	return [...dated, ...ongoing];
}

/**
 * Order asset cards by watchlist order (newest-first symbols), then within
 * each symbol keep selection order (soonest dated, then ongoing).
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
