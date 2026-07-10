import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";

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
