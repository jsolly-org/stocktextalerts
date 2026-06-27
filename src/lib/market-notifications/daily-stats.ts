import { createLogger } from "../logging";
import type { DailyOHLCVBar } from "../market-data/types";
import type { SupabaseAdminClient } from "../schedule/helpers";

export type { DailyOHLCVBar } from "../market-data/types";

const logger = createLogger({ module: "daily-stats" });

/* =============
Types
============= */

interface DailyAssetStats {
	symbol: string;
	avgVolume20d: number | null;
	atr14: number | null;
}

/* =============
Computation
============= */

/** Compute 20-day average daily volume from OHLCV bars. */
export function computeADV(bars: DailyOHLCVBar[]): number | null {
	if (bars.length < 20) return null;
	const volumes = bars.map((b) => b.volume).filter((v) => Number.isFinite(v) && v > 0);
	if (volumes.length === 0) return null;
	const recent = volumes.slice(-20);
	return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

/** Compute 14-day Average True Range (Wilder's method, SMA variant). */
export function computeATR(bars: DailyOHLCVBar[]): number | null {
	if (bars.length < 15) return null;

	const trueRanges: number[] = [];
	for (let i = 1; i < bars.length; i++) {
		const bar = bars[i];
		const prev = bars[i - 1];
		if (!bar || !prev) continue;
		const high = bar.high;
		const low = bar.low;
		const prevClose = prev.close;
		const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
		trueRanges.push(tr);
	}

	const recent = trueRanges.slice(-14);
	return recent.reduce((sum, tr) => sum + tr, 0) / recent.length;
}

/* =============
Database
============= */

/** Fetch daily_asset_stats for a list of symbols. */
export async function fetchDailyStats(
	supabase: SupabaseAdminClient,
	symbols: string[],
): Promise<Map<string, DailyAssetStats>> {
	const result = new Map<string, DailyAssetStats>();
	if (symbols.length === 0) return result;

	const { data, error } = await supabase
		.from("daily_asset_stats")
		.select("symbol, avg_volume_20d, atr_14")
		.in("symbol", symbols);

	if (error) {
		logger.error("Failed to fetch daily stats", { symbolCount: symbols.length }, error);
		return result;
	}
	if (!data) return result;

	for (const row of data) {
		result.set(row.symbol, {
			symbol: row.symbol,
			avgVolume20d: row.avg_volume_20d !== null ? Number(row.avg_volume_20d) : null,
			atr14: row.atr_14 !== null ? Number(row.atr_14) : null,
		});
	}

	return result;
}
