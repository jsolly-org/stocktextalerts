import { rootLogger } from "../logging";
import type { ExtendedQuoteMap } from "../providers/price-fetcher";
import type { SupabaseAdminClient } from "../schedule/helpers";

/** Single captured quote row from `asset_snapshots`. */
export interface AssetSnapshot {
	symbol: string;
	price: number;
	changePercent: number;
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	volume: number | null;
	capturedAt: string;
}

/** Minutes to retain asset snapshots; rows older than this are purged by `purgeOldAssetSnapshots`. */
export const RETENTION_MINUTES = 60;

/**
 * Bulk-insert current tick's quotes as snapshot rows.
 */
export async function storeSnapshots(
	supabase: SupabaseAdminClient,
	quoteMap: ExtendedQuoteMap,
): Promise<void> {
	const rows: Array<{
		symbol: string;
		price: number;
		change_percent: number;
		day_high: number | null;
		day_low: number | null;
		day_open: number | null;
		prev_close: number | null;
		volume: number | null;
	}> = [];

	for (const [symbol, quote] of quoteMap) {
		if (!quote) continue;
		rows.push({
			symbol,
			price: quote.price,
			change_percent: quote.changePercent,
			day_high: quote.dayHigh,
			day_low: quote.dayLow,
			day_open: quote.dayOpen,
			prev_close: quote.prevClose,
			volume: quote.volume,
		});
	}

	if (rows.length === 0) return;

	// Catch transport-level throws (ECONNREFUSED, AbortError) too — supabase-js
	// resolves to { error } for HTTP failures but can throw before reaching the
	// response. Anomaly detection degrades gracefully if this fails, so we
	// log and swallow rather than aborting the alert run.
	try {
		const { error } = await supabase.from("asset_snapshots").insert(rows);
		if (error) {
			rootLogger.error(
				"Failed to insert asset snapshots",
				{ count: rows.length },
				error,
			);
		}
	} catch (error) {
		rootLogger.error(
			"Failed to insert asset snapshots",
			{ count: rows.length },
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

/**
 * Fetch snapshots for a set of symbols within the retention window, ordered ASC.
 */
export async function getSnapshotsForSymbols(
	supabase: SupabaseAdminClient,
	symbols: string[],
): Promise<Map<string, AssetSnapshot[]>> {
	const result = new Map<string, AssetSnapshot[]>();
	if (symbols.length === 0) return result;

	const cutoff = new Date(
		Date.now() - RETENTION_MINUTES * 60 * 1000,
	).toISOString();

	const { data, error } = await (supabase
		.from("asset_snapshots")
		.select(
			"symbol, price, change_percent, day_high, day_low, day_open, prev_close, volume, captured_at",
		)
		.in("symbol", symbols)
		.gte("captured_at", cutoff)
		.order("captured_at", { ascending: true }) as unknown as Promise<{
		data: Array<{
			symbol: string;
			price: number;
			change_percent: number;
			day_high: number | null;
			day_low: number | null;
			day_open: number | null;
			prev_close: number | null;
			volume: number | null;
			captured_at: string;
		}> | null;
		error: unknown;
	}>);

	if (error) {
		rootLogger.error(
			"Failed to fetch asset snapshots",
			{ symbolCount: symbols.length },
			error,
		);
		return result;
	}

	for (const row of data ?? []) {
		const snapshot: AssetSnapshot = {
			symbol: row.symbol,
			price: row.price,
			changePercent: row.change_percent,
			dayHigh: row.day_high,
			dayLow: row.day_low,
			dayOpen: row.day_open,
			prevClose: row.prev_close,
			volume: row.volume,
			capturedAt: row.captured_at,
		};
		const existing = result.get(row.symbol) ?? [];
		existing.push(snapshot);
		result.set(row.symbol, existing);
	}

	return result;
}

/**
 * Purge asset_snapshots older than the retention window via Postgres RPC.
 * Call from cron (e.g. /api/schedule) so the table does not grow unbounded.
 */
export async function purgeOldAssetSnapshots(
	supabase: SupabaseAdminClient,
	retentionMinutes: number = RETENTION_MINUTES,
): Promise<number> {
	if (!Number.isFinite(retentionMinutes) || retentionMinutes <= 0) {
		rootLogger.error("Invalid retentionMinutes for purgeOldAssetSnapshots", {
			retentionMinutes,
		});
		return 0;
	}
	const { data, error } = await supabase.rpc("purge_old_asset_snapshots", {
		p_retention_minutes: retentionMinutes,
	});
	if (error) {
		rootLogger.error(
			"Failed to purge old asset snapshots",
			{ retentionMinutes },
			error,
		);
		return 0;
	}
	return typeof data === "number" ? data : 0;
}
