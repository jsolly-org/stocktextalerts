import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { updateUserNextSendAtSingleTime } from "../time/schedule/persist-user";
import type { UserRecord } from "../user-record-types";

/* Recompute because timezone/DST offsets can shift the user's intended local delivery time. */
/**
 * Recompute and persist `users.daily_digest_next_send_at` for a user.
 *
 * Clears the field when daily delivery is disabled, otherwise calculates the next UTC send
 * timestamp based on the user's local delivery time and timezone.
 */
export async function updateUserDailyDigestNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	return updateUserNextSendAtSingleTime({
		...options,
		column: "daily_digest_next_send_at",
		getLocalMinutes: (user) => user.daily_digest_time,
	});
}
