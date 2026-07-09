import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { withOptionalVendorBudget } from "../vendors/optional-vendors";
import { fetchCuratedPredictionMarketReadings } from "./fetch";
import {
	attachPredictionMarketDeltas,
	loadPredictionMarketBaselines,
	storePredictionMarketOddsSnapshot,
} from "./store";
import type { PredictionMarketReading } from "./types";

/** Process-local memo so a multi-user digest cron doesn't re-hit vendors per user. */
const SECTION_CACHE_TTL_MS = 5 * 60 * 1000;
/** Wall-clock budget for the whole curated strip (parallel venue calls). */
const STRIP_BUDGET_MS = 15_000;
let cachedReadings: { value: PredictionMarketReading[] | null; expiresAt: number } | null = null;
let inFlight: Promise<PredictionMarketReading[] | null> | null = null;

/**
 * Fetch curated prediction-market readings for the daily digest, with day-over-day
 * deltas vs the prior global snapshot. Soft-fails to `null` when every vendor
 * call fails or the strip budget is exceeded. Memoized briefly per process so
 * concurrent digest users share one fetch.
 */
export async function buildPredictionMarketsReadings(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<PredictionMarketReading[] | null> {
	const { supabase, logger } = options;
	const now = Date.now();
	if (cachedReadings && cachedReadings.expiresAt > now) {
		return cachedReadings.value;
	}
	if (inFlight) return inFlight;

	inFlight = (async () => {
		try {
			const budgeted = await withOptionalVendorBudget("prediction-markets", STRIP_BUDGET_MS, () =>
				fetchCuratedPredictionMarketReadings({ logger }),
			);
			if (budgeted.status !== "ok") {
				cachedReadings = { value: null, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
				return null;
			}

			const fresh = budgeted.value;
			if (fresh.length === 0) {
				logger.warn("Prediction markets strip empty (all curated fetches failed or inactive)", {});
				cachedReadings = { value: null, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
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

			cachedReadings = { value: withDeltas, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
			return withDeltas;
		} catch (error) {
			logger.warn(
				"Prediction markets strip failed (non-fatal)",
				{},
				error instanceof Error ? error : new Error(String(error)),
			);
			cachedReadings = { value: null, expiresAt: Date.now() + SECTION_CACHE_TTL_MS };
			return null;
		}
	})().finally(() => {
		inFlight = null;
	});

	return inFlight;
}
