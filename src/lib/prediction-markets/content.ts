import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { UserAssetRow } from "../types";
import { withOptionalVendorBudget } from "../vendors/optional-vendors";
import { directionEventToCard, resolveNextSessionDirectionEvent } from "./direction-probe";
import { fetchCuratedPredictionMarketCards } from "./fetch";
import { loadAcceptedMatchesForSymbols, persistDiscoveredMatches } from "./registry";
import {
	hasFutureDailyDirectionMarket,
	orderCardsByWatchlist,
	selectAssetEventCards,
} from "./select";
import type { PredictionMarketEventCard, PredictionMarketsDigestContent } from "./types";

/** Process-local memo so a multi-user digest cron doesn't re-hit vendors per user. */
const SECTION_CACHE_TTL_MS = 5 * 60 * 1000;
/** Wall-clock budget for the curated macro strip (parallel venue calls). */
const STRIP_BUDGET_MS = 15_000;
/** Soft budget for filling missing next-session up/down markets per digest build. */
const DIRECTION_FILL_BUDGET_MS = 12_000;
let cachedMacro: { value: PredictionMarketEventCard[] | null; expiresAt: number } | null = null;
let inFlightMacro: Promise<PredictionMarketEventCard[] | null> | null = null;

async function buildMacroCards(options: {
	logger: Logger;
}): Promise<PredictionMarketEventCard[] | null> {
	const { logger } = options;
	const now = Date.now();
	if (cachedMacro && cachedMacro.expiresAt > now) {
		return cachedMacro.value;
	}
	if (inFlightMacro) return inFlightMacro;

	inFlightMacro = (async () => {
		try {
			const budgeted = await withOptionalVendorBudget("prediction-markets", STRIP_BUDGET_MS, () =>
				fetchCuratedPredictionMarketCards({ logger }),
			);
			if (budgeted.status !== "ok") {
				cachedMacro = { value: null, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
				return null;
			}

			const fresh = budgeted.value;
			if (fresh.length === 0) {
				logger.warn("Prediction markets strip empty (all curated fetches failed or inactive)", {});
				cachedMacro = { value: null, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
				return null;
			}

			cachedMacro = { value: fresh, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
			return fresh;
		} catch (error) {
			logger.warn(
				"Prediction markets strip failed (non-fatal)",
				{},
				error instanceof Error ? error : new Error(String(error)),
			);
			cachedMacro = { value: null, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
			return null;
		}
	})().finally(() => {
		inFlightMacro = null;
	});

	return inFlightMacro;
}

/**
 * Build grouped prediction-market content for one digest user:
 * stored asset event cards + next-session up/down fill-in + curated macro.
 *
 * Asset cards are next-session up/down only (no KPI / subject fallback).
 * One-shot discovery never sees rotating Polymarket dailies, so when DB cards
 * lack a future-session up/down we probe the deterministic slug and use it.
 */
export async function buildPredictionMarketsDigestContent(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	userAssets: readonly UserAssetRow[];
}): Promise<PredictionMarketsDigestContent | null> {
	const { supabase, logger, userAssets } = options;
	const nowMs = Date.now();

	const macroPromise = buildMacroCards({ logger });

	// Newest-first watchlist order (getUserAssets already orders created_at DESC).
	const watchlistSymbols = userAssets.map((a) => a.symbol);
	const stored = await loadAcceptedMatchesForSymbols({
		supabase,
		logger,
		symbols: watchlistSymbols,
	});

	const bySymbol = new Map<string, PredictionMarketEventCard[]>();
	for (const row of stored) {
		const card: PredictionMarketEventCard = {
			key: row.key,
			title: row.title,
			venue: row.venue,
			url: row.url,
			shape: row.shape,
			closesAt: row.closesAt,
			refreshedAt: row.refreshedAt,
			volume: row.volume,
			outcomes: row.outcomes,
			symbol: row.symbol,
			matchKind: row.matchKind,
			shapeValidated: row.shapeValidated,
		};
		const list = bySymbol.get(row.symbol) ?? [];
		list.push(card);
		bySymbol.set(row.symbol, list);
	}

	const symbolsNeedingDirection = watchlistSymbols.filter(
		(symbol) => !hasFutureDailyDirectionMarket(bySymbol.get(symbol) ?? [], { nowMs }),
	);

	if (symbolsNeedingDirection.length > 0) {
		const fill = await withOptionalVendorBudget(
			"prediction-markets",
			DIRECTION_FILL_BUDGET_MS,
			async () => {
				let found = 0;
				for (const symbol of symbolsNeedingDirection) {
					const event = await resolveNextSessionDirectionEvent({ symbol, logger, nowMs });
					if (!event) continue;
					found += 1;
					const card = directionEventToCard(symbol, event);
					const list = bySymbol.get(symbol) ?? [];
					list.push(card);
					bySymbol.set(symbol, list);
					try {
						await persistDiscoveredMatches({
							supabase,
							logger,
							symbol,
							markets: [event],
							replaceAcceptedSet: false,
						});
					} catch (error) {
						logger.warn(
							"Failed to persist probed direction market (non-fatal)",
							{ symbol, key: card.key },
							error instanceof Error ? error : new Error(String(error)),
						);
					}
				}
				return found;
			},
		);
		if (fill.status !== "ok") {
			logger.warn("Next-session direction fill skipped or timed out", {
				status: fill.status,
				needed: symbolsNeedingDirection.length,
			});
		}
	}

	const selectedBySymbol = new Map<string, PredictionMarketEventCard[]>();
	for (const symbol of watchlistSymbols) {
		const cards = bySymbol.get(symbol) ?? [];
		if (cards.length === 0) continue;
		selectedBySymbol.set(symbol, selectAssetEventCards(cards, { nowMs }));
	}

	const assetCards = orderCardsByWatchlist(selectedBySymbol, watchlistSymbols);
	const macroCards = (await macroPromise) ?? [];

	if (assetCards.length === 0 && macroCards.length === 0) {
		return null;
	}

	return { assetCards, macroCards };
}
