import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { PredictionMarketReading } from "./types";

type OddsSnapshotRow = {
	market_key: string;
	probability_percent: number;
	captured_at: string;
};

/** Minimum age before a new global snapshot replaces the prior baseline. */
const SNAPSHOT_MIN_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Persist a fresh global snapshot when the latest row is older than
 * {@link SNAPSHOT_MIN_AGE_MS}. Same-day digest runs for many users share one
 * baseline so deltas stay meaningful.
 */
export async function storePredictionMarketOddsSnapshot(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	readings: readonly PredictionMarketReading[];
	capturedAt?: string;
}): Promise<void> {
	const { supabase, logger, readings } = options;
	if (readings.length === 0) return;

	const capturedAt = options.capturedAt ?? new Date().toISOString();
	const capturedAtMs = Date.parse(capturedAt);
	const keys = readings.map((r) => r.key);

	const { data: latestRows, error: latestError } = await supabase
		.from("prediction_market_odds")
		.select("market_key,captured_at")
		.in("market_key", keys)
		.order("captured_at", { ascending: false });

	if (latestError) {
		logger.error(
			"Failed to check latest prediction-market odds before insert",
			{ marketKeyCount: keys.length },
			latestError,
		);
		return;
	}

	const latestCapturedAt = new Map<string, number>();
	for (const row of (latestRows ?? []) as Array<{ market_key: string; captured_at: string }>) {
		if (latestCapturedAt.has(row.market_key)) continue;
		const ts = Date.parse(row.captured_at);
		if (Number.isFinite(ts)) latestCapturedAt.set(row.market_key, ts);
	}

	const rows = readings
		.filter((reading) => {
			const prevTs = latestCapturedAt.get(reading.key);
			if (prevTs === undefined) return true;
			return capturedAtMs - prevTs >= SNAPSHOT_MIN_AGE_MS;
		})
		.map((reading) => ({
			market_key: reading.key,
			venue: reading.venue,
			probability_percent: reading.probabilityPercent,
			captured_at: capturedAt,
		}));

	if (rows.length === 0) {
		logger.info("Prediction-market odds snapshot skipped (fresh enough)", {
			marketKeyCount: keys.length,
		});
		return;
	}

	const { error } = await supabase.from("prediction_market_odds").insert(rows);
	if (error) {
		logger.error(
			"Failed to store prediction-market odds snapshot",
			{ rowCount: rows.length },
			error,
		);
	}
}

/**
 * Attach deltaPoints. When the latest snapshot is still "current" (< 12h),
 * use the *second*-most-recent row as the baseline so same-day digests don't
 * show ~0 deltas against a snapshot we just wrote.
 */
export async function loadPredictionMarketBaselines(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	marketKeys: readonly string[];
}): Promise<Map<string, number>> {
	const { supabase, logger, marketKeys } = options;
	const baselines = new Map<string, number>();
	if (marketKeys.length === 0) return baselines;

	const { data, error } = await supabase
		.from("prediction_market_odds")
		.select("market_key,probability_percent,captured_at")
		.in("market_key", [...marketKeys])
		.order("captured_at", { ascending: false });

	if (error) {
		logger.error(
			"Failed to load prediction-market odds baselines",
			{ marketKeyCount: marketKeys.length },
			error,
		);
		return baselines;
	}

	const now = Date.now();
	const counts = new Map<string, number>();

	for (const row of (data ?? []) as OddsSnapshotRow[]) {
		const value = Number(row.probability_percent);
		if (!Number.isFinite(value)) continue;

		const capturedMs = Date.parse(row.captured_at);
		const isFresh = Number.isFinite(capturedMs) && now - capturedMs < SNAPSHOT_MIN_AGE_MS;
		const n = counts.get(row.market_key) ?? 0;
		counts.set(row.market_key, n + 1);

		if (n === 0 && isFresh) {
			// Skip the current-day snapshot; wait for the prior one.
			continue;
		}
		if (baselines.has(row.market_key)) continue;
		baselines.set(row.market_key, value);
	}

	return baselines;
}

/** Attach deltaPoints from a previous-odds map onto fresh readings. */
export function attachPredictionMarketDeltas(
	readings: readonly PredictionMarketReading[],
	previousOdds: ReadonlyMap<string, number>,
): PredictionMarketReading[] {
	return readings.map((reading) => {
		const prev = previousOdds.get(reading.key);
		if (prev === undefined) {
			return { ...reading, deltaPoints: null };
		}
		const delta = Math.round((reading.probabilityPercent - prev) * 10) / 10;
		return { ...reading, deltaPoints: delta };
	});
}

/** Purge odds snapshots older than the retention window. Soft-fails on RPC error. */
export async function purgeOldPredictionMarketOdds(
	supabase: SupabaseAdminClient,
	logger: Logger,
	retentionDays = 30,
): Promise<number> {
	const { data, error } = await supabase.rpc("purge_old_prediction_market_odds", {
		p_retention_days: retentionDays,
	});
	if (error) {
		logger.error("Failed to purge prediction_market_odds", { retentionDays }, error);
		return 0;
	}
	return typeof data === "number" ? data : 0;
}
