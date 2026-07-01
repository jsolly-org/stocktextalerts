import { hasAnyDailyNotificationFacet } from "../daily-notification/eligibility";
import {
	DAILY_NOTIFICATION_USER_SELECT,
	HAS_DELIVERY_CHANNEL_OR,
} from "../daily-notification/query";
import type { SupabaseAdminClient } from "../db/supabase";
import { fetchUsersWithRetry } from "../db/user-query";
import type { Logger } from "../logging/types";
import { attachPrefsToUsers } from "../messaging/load-prefs";
import type { UserRecord, UserRecordWithoutPrefs } from "../types";

/** Fetch users whose daily notification is due in an upcoming time window. */
export async function fetchUpcomingDailyDigestUsers(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	afterTimeIso: string;
	beforeTimeIso: string;
}): Promise<UserRecord[]> {
	const { afterTimeIso, beforeTimeIso } = options;
	return fetchUsersWithRetry<UserRecord>({
		supabase: options.supabase,
		logger: options.logger,
		label: "upcoming daily users",
		execute: async () => {
			const { data, error } = await options.supabase
				.from("users")
				.select(DAILY_NOTIFICATION_USER_SELECT)
				.or(HAS_DELIVERY_CHANNEL_OR)
				.or(
					`and(daily_notification_next_send_at.not.is.null,daily_notification_next_send_at.gt.${afterTimeIso},daily_notification_next_send_at.lte.${beforeTimeIso})`,
				);

			if (error) return { data: null, error };

			const withPrefs = await attachPrefsToUsers(
				options.supabase,
				(data ?? []) as unknown as UserRecordWithoutPrefs[],
			);
			const filtered = (withPrefs as UserRecord[]).filter((user) =>
				hasAnyDailyNotificationFacet(user.prefs),
			);
			return { data: filtered, error: null };
		},
	});
}
