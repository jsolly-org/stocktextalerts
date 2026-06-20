import { fetchUsersWithRetry } from "../db/user-query";
import type { Logger } from "../logging";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { DAILY_DIGEST_USER_SELECT, HAS_DELIVERY_CHANNEL_OR } from "./query";

type UserRecordWithoutPrefs = Omit<UserRecord, "prefs">;

/** Fetch users whose daily digest is due in an upcoming time window. */
export async function fetchUpcomingDailyDigestUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	afterTimeIso: string;
	beforeTimeIso: string;
}): Promise<UserRecord[]> {
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "upcoming daily users",
		execute: async () => {
			const { data, error } = await options.supabase
				.from("users")
				.select(DAILY_DIGEST_USER_SELECT)
				.not("daily_digest_time", "is", null)
				.or(HAS_DELIVERY_CHANNEL_OR)
				.not("daily_digest_next_send_at", "is", null)
				.gt("daily_digest_next_send_at", options.afterTimeIso)
				.lte("daily_digest_next_send_at", options.beforeTimeIso);

			if (error) return { data: null, error };

			const withPrefs = await attachPrefsToUsers(
				options.supabase,
				(data ?? []) as unknown as UserRecordWithoutPrefs[],
			);
			return { data: withPrefs as UserRecord[], error: null };
		},
	});
}
