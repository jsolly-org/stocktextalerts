import type { SupabaseAdminClient } from "../../db/supabase";
import type { Logger } from "../../logging";

/** Max successful price-move why Grok claims per rolling window (per user). */
export const PRICE_MOVE_WHY_MAX_SENDS_PER_WINDOW = 20;

/**
 * Atomically claim one slot in the user's 20/24h why budget before calling Grok.
 * Returns false when the cap is reached or the user row is missing.
 */
export async function claimPriceMoveWhyBudget(
	supabase: SupabaseAdminClient,
	userId: string,
	logger: Logger,
): Promise<boolean> {
	const { data, error } = await supabase.rpc("claim_price_move_why_budget", {
		p_user_id: userId,
	});

	if (error) {
		logger.error("Failed to claim price-move why budget", { userId }, error);
		return false;
	}

	return Boolean(data);
}
