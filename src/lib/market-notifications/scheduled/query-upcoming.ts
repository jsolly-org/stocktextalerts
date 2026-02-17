import { fetchUsersWithRetry } from "../../db/user-query";
import type { Logger } from "../../logging";
import type { UserRecord } from "../../messaging/types";
import type { SupabaseAdminClient } from "../../schedule/helpers";
import {
	HAS_DELIVERY_CHANNEL_OR,
	MARKET_SCHEDULED_USER_SELECT,
} from "./select";

/** Fetch users whose market scheduled update is due in an upcoming time window. */
export async function fetchUpcomingMarketScheduledUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	afterTimeIso: string;
	beforeTimeIso: string;
}): Promise<UserRecord[]> {
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "upcoming market users",
		execute: async () => {
			const { data, error } = await options.supabase
				.from("users")
				.select(MARKET_SCHEDULED_USER_SELECT)
				.eq("market_scheduled_asset_price_enabled", true)
				.not("market_scheduled_asset_price_times", "is", null)
				.or(HAS_DELIVERY_CHANNEL_OR)
				.not("market_scheduled_asset_price_next_send_at", "is", null)
				.gt("market_scheduled_asset_price_next_send_at", options.afterTimeIso)
				.lte(
					"market_scheduled_asset_price_next_send_at",
					options.beforeTimeIso,
				);

			if (error) return { data: null, error };
			return { data: (data ?? []) as UserRecord[], error: null };
		},
	});
}
