import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
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

/** Next-day / session direction markets (e.g. "AAPL Up or Down on July 31?"). */
function isDailyDirectionMarket(card: PredictionMarketEventCard): boolean {
	return /\bup or down\b/i.test(card.title);
}

/**
 * End-of-month / strike price targets — deprioritized vs daily up/down.
 * Daily direction titles are never treated as price targets.
 * Relies on matchKind from discovery (not a second title lexicon).
 */
function isPriceTargetMarket(card: PredictionMarketEventCard): boolean {
	if (isDailyDirectionMarket(card)) return false;
	return card.matchKind === "direct_price";
}

/** ET calendar date of the market's session (from closesAt, typically 4pm ET). */
function sessionDateEt(card: PredictionMarketEventCard): string | null {
	if (!card.closesAt) return null;
	const dt = DateTime.fromISO(card.closesAt, { zone: "utc" }).setZone(US_MARKET_TIMEZONE);
	return dt.isValid ? dt.toISODate() : null;
}

function todayDateEt(nowMs: number): string | null {
	const dt = DateTime.fromMillis(nowMs, { zone: "utc" }).setZone(US_MARKET_TIMEZONE);
	return dt.isValid ? dt.toISODate() : null;
}

function soonestCloseFirst(a: PredictionMarketEventCard, b: PredictionMarketEventCard): number {
	const aTs = a.closesAt ? Date.parse(a.closesAt) : Number.POSITIVE_INFINITY;
	const bTs = b.closesAt ? Date.parse(b.closesAt) : Number.POSITIVE_INFINITY;
	if (aTs !== bTs) return aTs - bTs;
	return b.volume - a.volume;
}

/**
 * Per-asset selection — at most one prediction-market card per ticker:
 * - Prefer the soonest daily up/down for a *future* ET session (tomorrow+, never today)
 * - Else soonest non-price-target future close
 * - Else the highest-volume undated ongoing card when title-salient and volume > 0
 * - Macro/curated markets are selected separately and are unaffected
 */
export function selectAssetEventCards(
	cards: readonly PredictionMarketEventCard[],
	options: { nowMs?: number } = {},
): PredictionMarketEventCard[] {
	const nowMs = options.nowMs ?? Date.now();
	const todayEt = todayDateEt(nowMs);

	const freshOpen = cards.filter(
		(c) =>
			c.outcomes.length > 0 &&
			isFresh(c.refreshedAt, nowMs) &&
			// Reject expired dated markets; undated stay eligible for ongoing lane.
			(c.closesAt === null || isFutureClose(c.closesAt, nowMs)),
	);

	const bestDirection =
		todayEt === null
			? undefined
			: [...freshOpen.filter(isDailyDirectionMarket)]
					.filter((c) => {
						const session = sessionDateEt(c);
						// Next-day (or next available session): strictly after today in ET.
						return session !== null && session > todayEt;
					})
					.sort(soonestCloseFirst)[0];
	if (bestDirection) return [bestDirection];

	// Direction markets only compete in the preferred lane (future session).
	// Do not fall back to today's still-open up/down via the dated lane.
	const nonPrice = freshOpen.filter((c) => !isPriceTargetMarket(c) && !isDailyDirectionMarket(c));

	const soonestDated = nonPrice.filter((c) => c.closesAt !== null).sort(soonestCloseFirst)[0];
	if (soonestDated) return [soonestDated];

	const bestOngoing = nonPrice
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
