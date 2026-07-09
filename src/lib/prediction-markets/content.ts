import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { UserAssetRow } from "../types";
import { withOptionalVendorBudget } from "../vendors/optional-vendors";
import { fetchCuratedPredictionMarketReadings } from "./fetch";
import { selectDigestAssetMarkets } from "./rank";
import { loadAcceptedMatchesForSymbols } from "./registry";
import {
	attachPredictionMarketDeltas,
	loadPredictionMarketBaselines,
	storePredictionMarketOddsSnapshot,
} from "./store";
import type { PredictionMarketReading, PredictionMarketsDigestContent } from "./types";

/** Process-local memo so a multi-user digest cron doesn't re-hit vendors per user. */
const SECTION_CACHE_TTL_MS = 5 * 60 * 1000;
/** Wall-clock budget for the curated macro strip (parallel venue calls). */
const STRIP_BUDGET_MS = 15_000;
let cachedMacro: { value: PredictionMarketReading[] | null; expiresAt: number } | null = null;
let inFlightMacro: Promise<PredictionMarketReading[] | null> | null = null;

async function buildMacroReadings(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<PredictionMarketReading[] | null> {
	const { supabase, logger } = options;
	const now = Date.now();
	if (cachedMacro && cachedMacro.expiresAt > now) {
		return cachedMacro.value;
	}
	if (inFlightMacro) return inFlightMacro;

	inFlightMacro = (async () => {
		try {
			const budgeted = await withOptionalVendorBudget("prediction-markets", STRIP_BUDGET_MS, () =>
				fetchCuratedPredictionMarketReadings({ logger }),
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

			const baselines = await loadPredictionMarketBaselines({
				supabase,
				logger,
				marketKeys: fresh.map((r) => r.key),
			});
			const withDeltas = attachPredictionMarketDeltas(fresh, baselines);

			await storePredictionMarketOddsSnapshot({
				supabase,
				logger,
				readings: withDeltas,
			});

			cachedMacro = { value: withDeltas, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
			return withDeltas;
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

type AssetMarketReading = PredictionMarketReading & { symbol: string };

/**
 * Build grouped prediction-market content for one digest user:
 * stored asset matches (no vendor calls) + process-cached curated macro.
 */
export async function buildPredictionMarketsDigestContent(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	userAssets: readonly UserAssetRow[];
}): Promise<PredictionMarketsDigestContent | null> {
	const { supabase, logger, userAssets } = options;

	const macroPromise = buildMacroReadings({ supabase, logger });

	const symbols = userAssets.map((a) => a.symbol);
	const stored = await loadAcceptedMatchesForSymbols({ supabase, logger, symbols });

	const bySymbol = new Map<string, AssetMarketReading[]>();
	for (const row of stored) {
		const reading: AssetMarketReading = {
			key: row.key,
			label: row.label,
			venue: row.venue,
			probabilityPercent: row.probabilityPercent,
			deltaPoints: null,
			url: row.url,
			symbol: row.symbol,
			matchKind: row.matchKind,
		};
		const list = bySymbol.get(row.symbol) ?? [];
		list.push(reading);
		bySymbol.set(row.symbol, list);
	}

	// Prefer higher-confidence / price-first within each symbol (already ranked at discovery;
	// re-sort lightly for display stability).
	for (const [sym, list] of bySymbol) {
		list.sort((a, b) => {
			const rank = (k: string | undefined) => (k === "direct_price" ? 0 : k === "kpi" ? 1 : 2);
			return rank(a.matchKind) - rank(b.matchKind);
		});
		bySymbol.set(sym, list);
	}

	let assetMarkets: AssetMarketReading[] = selectDigestAssetMarkets(bySymbol, {
		perAsset: 2,
		globalCap: 6,
	});

	if (assetMarkets.length > 0) {
		const baselines = await loadPredictionMarketBaselines({
			supabase,
			logger,
			marketKeys: assetMarkets.map((r) => r.key),
		});
		assetMarkets = attachPredictionMarketDeltas(assetMarkets, baselines).map((r) => {
			if (!r.symbol) {
				throw new Error(`Asset prediction market reading missing symbol: ${r.key}`);
			}
			return { ...r, symbol: r.symbol };
		});
		await storePredictionMarketOddsSnapshot({
			supabase,
			logger,
			readings: assetMarkets,
		});
	}

	const macroMarkets = (await macroPromise) ?? [];

	if (assetMarkets.length === 0 && macroMarkets.length === 0) {
		return null;
	}

	return { assetMarkets, macroMarkets };
}
