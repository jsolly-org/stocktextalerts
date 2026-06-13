export interface DailyStatsRow {
	symbol: string;
	computed_at: string;
	avg_volume_20d: number | null;
	atr_14: number | null;
}

interface DailyStatsUpsertResult {
	upserted: number;
	failedChunks: number;
	failedRows: number;
}

/** Executor matches `supabase.from(...).upsert(rows, { onConflict: "symbol" })`. */
type DailyStatsUpsertExecutor = (
	rows: DailyStatsRow[],
) => Promise<{ error: { message: string } | null }>;

/**
 * Upsert daily stats in independent chunks so one failing chunk (deadlock,
 * transient DB error) doesn't discard the rows that did persist. Returns
 * per-chunk failure counts for alarm logging; never throws.
 */
export async function upsertDailyStatsInChunks(
	rows: DailyStatsRow[],
	upsert: DailyStatsUpsertExecutor,
	chunkSize = 500,
): Promise<DailyStatsUpsertResult> {
	let upserted = 0;
	let failedChunks = 0;
	let failedRows = 0;

	for (let i = 0; i < rows.length; i += chunkSize) {
		const chunk = rows.slice(i, i + chunkSize);
		const { error } = await upsert(chunk);
		if (error) {
			failedChunks++;
			failedRows += chunk.length;
		} else {
			upserted += chunk.length;
		}
	}

	return { upserted, failedChunks, failedRows };
}
