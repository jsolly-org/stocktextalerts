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

/** Next-day / session direction markets (e.g. "AAPL Up or Down on July 31?"). */
function isDailyDirectionMarket(card: PredictionMarketEventCard): boolean {
	return /\bup or down\b/i.test(card.title);
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
 * only the soonest daily up/down for a *future* ET session (tomorrow+, never today).
 * KPI / company-subject / price-target / ongoing markets are never shown.
 * Macro/curated markets are selected separately and are unaffected.
 */
export function selectAssetEventCards(
	cards: readonly PredictionMarketEventCard[],
	options: { nowMs?: number } = {},
): PredictionMarketEventCard[] {
	const nowMs = options.nowMs ?? Date.now();
	const todayEt = todayDateEt(nowMs);
	if (todayEt === null) return [];

	const bestDirection = [...cards]
		.filter(
			(c) =>
				isDailyDirectionMarket(c) &&
				c.outcomes.length > 0 &&
				isFresh(c.refreshedAt, nowMs) &&
				(c.closesAt === null || isFutureClose(c.closesAt, nowMs)),
		)
		.filter((c) => {
			const session = sessionDateEt(c);
			// Next-day (or next available session): strictly after today in ET.
			return session !== null && session > todayEt;
		})
		.sort(soonestCloseFirst)[0];

	return bestDirection ? [bestDirection] : [];
}

/**
 * True when cards already include a fresh daily up/down for a future ET session
 * (the only digest asset lane). Used to skip live direction probes.
 */
export function hasFutureDailyDirectionMarket(
	cards: readonly PredictionMarketEventCard[],
	options: { nowMs?: number } = {},
): boolean {
	return selectAssetEventCards(cards, options).length > 0;
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
