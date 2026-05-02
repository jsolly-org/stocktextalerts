import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { updateUserNextSendAtSingleTime } from "../time/update-user-next-send-at";

const DEFAULT_DELIVERY_MINUTES = 540; // 9:00 AM

/**
 * Recompute and persist `users.asset_events_next_send_at` for a user.
 *
 * Clears the field when asset events options are disabled, otherwise calculates
 * the next daily send timestamp (in UTC) using the user's timezone and preferred
 * local delivery time.
 */
export async function updateUserAssetEventsNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	const hasAssetEventsOption =
		options.user.asset_events_include_calendar_email ||
		options.user.asset_events_include_calendar_sms ||
		options.user.asset_events_include_ipo_email ||
		options.user.asset_events_include_ipo_sms ||
		options.user.asset_events_include_analyst_email ||
		options.user.asset_events_include_analyst_sms ||
		options.user.asset_events_include_insider_email ||
		options.user.asset_events_include_insider_sms;

	return updateUserNextSendAtSingleTime({
		...options,
		column: "asset_events_next_send_at",
		getLocalMinutes: (user) =>
			hasAssetEventsOption ? (user.daily_digest_time ?? DEFAULT_DELIVERY_MINUTES) : null,
	});
}
