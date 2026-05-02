import { fetchUsersWithRetry } from "../../db/user-query";
import type { Logger } from "../../logging";
import type { UserRecord } from "../../messaging/types";
import type { SupabaseAdminClient } from "../../schedule/helpers";
import { HAS_DELIVERY_CHANNEL_OR, MARKET_SCHEDULED_USER_SELECT } from "./select";

/**
 * Fetch users eligible for a scheduled asset price update run.
 *
 * When `forceSend` is false, users are filtered by `market_scheduled_asset_price_next_send_at <= currentTimeIso`.
 * Retries transient Supabase errors a small number of times before throwing.
 *
 * Force-send: when manual send, include users even if market_scheduled_asset_price_next_send_at is null
 * (e.g. newly enabled scheduled updates). For normal cron, only process users due to send.
 */
export async function fetchMarketScheduledUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	currentTimeIso: string;
}): Promise<UserRecord[]> {
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "scheduled users",
		execute: async () => {
			let query = options.supabase
				.from("users")
				.select(MARKET_SCHEDULED_USER_SELECT)
				.eq("market_scheduled_asset_price_enabled", true)
				.not("market_scheduled_asset_price_times", "is", null)
				.or(HAS_DELIVERY_CHANNEL_OR);

			if (!options.forceSend) {
				query = query
					.not("market_scheduled_asset_price_next_send_at", "is", null)
					.lte("market_scheduled_asset_price_next_send_at", options.currentTimeIso);
			}

			const { data, error } = await query;
			if (error) return { data: null, error };
			return { data: (data ?? []) as UserRecord[], error: null };
		},
	});
}
