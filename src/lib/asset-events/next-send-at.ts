import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import { anyFacetEnabled } from "../messaging/notification-prefs";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { persistUserNextSendAtColumn } from "../time/schedule/persist-user";
import type { UserRecord } from "../user-record-types";
import { calculateAssetEventsNextSendAtIso } from "./scheduling-helpers";

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
	const prefs = options.user.prefs;
	const hasAssetEventsOption =
		anyFacetEnabled(prefs, "asset_events", "email") ||
		anyFacetEnabled(prefs, "asset_events", "sms") ||
		anyFacetEnabled(prefs, "asset_events", "telegram");

	const nextSendAtIso = hasAssetEventsOption
		? calculateAssetEventsNextSendAtIso({
				dailyDigestTime: options.user.daily_digest_time,
				timezone: options.user.timezone,
				now: options.currentTime,
			})
		: null;

	return persistUserNextSendAtColumn({
		userId: options.user.id,
		supabase: options.supabase,
		logger: options.logger,
		column: "asset_events_next_send_at",
		nextSendAtIso,
	});
}
