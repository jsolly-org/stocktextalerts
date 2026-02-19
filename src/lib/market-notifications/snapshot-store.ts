import { rootLogger } from "../logging";
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
