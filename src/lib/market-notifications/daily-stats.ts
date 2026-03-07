import type { SupabaseAdminClient } from "../schedule/helpers";

/* =============
Types
============= */

export interface DailyOHLCVBar {
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

export interface DailyAssetStats {
	symbol: string;
	avgVolume20d: number | null;
	atr14: number | null;
}

/* =============
Computation
============= */

/** Compute 20-day average daily volume from OHLCV bars. */
export function computeADV(bars: DailyOHLCVBar[]): number | null {
	const volumes = bars
		.map((b) => b.volume)
		.filter((v) => Number.isFinite(v) && v > 0);
	if (volumes.length === 0) return null;
	const recent = volumes.slice(-20);
	return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

/** Compute 14-day Average True Range (Wilder's method, SMA variant). */
export function computeATR(bars: DailyOHLCVBar[]): number | null {
	if (bars.length < 2) return null;

	const trueRanges: number[] = [];
	for (let i = 1; i < bars.length; i++) {
		const high = bars[i].high;
		const low = bars[i].low;
		const prevClose = bars[i - 1].close;
		const tr = Math.max(
			high - low,
			Math.abs(high - prevClose),
			Math.abs(low - prevClose),
		);
		trueRanges.push(tr);
	}

	// Need at least 14 TR values for a proper ATR-14
	const period = Math.min(14, trueRanges.length);
	const recent = trueRanges.slice(-period);
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

	if (error || !data) return result;

	for (const row of data) {
		result.set(row.symbol, {
			symbol: row.symbol,
			avgVolume20d:
				row.avg_volume_20d !== null ? Number(row.avg_volume_20d) : null,
			atr14: row.atr_14 !== null ? Number(row.atr_14) : null,
		});
	}

	return result;
}
