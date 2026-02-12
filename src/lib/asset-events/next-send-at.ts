import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { calculateNextSendAt } from "../time/scheduled-times";

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
	const { user, supabase, logger, currentTime } = options;

	const hasAssetEventsOption =
		user.asset_events_include_earnings_email ||
		user.asset_events_include_earnings_sms ||
		user.asset_events_include_dividends_email ||
		user.asset_events_include_dividends_sms ||
		user.asset_events_include_splits_email ||
		user.asset_events_include_splits_sms ||
		user.asset_events_include_analyst_email ||
		user.asset_events_include_analyst_sms ||
		user.asset_events_include_insider_email ||
		user.asset_events_include_insider_sms;

	if (!hasAssetEventsOption) {
		const { error } = await supabase
			.from("users")
			.update({ asset_events_next_send_at: null })
			.eq("id", user.id);
		if (error) {
			logger.error(
				"Failed to clear users.asset_events_next_send_at",
				{ userId: user.id },
				error,
			);
		}
		return;
	}

	const nextSendAt = calculateNextSendAt(
		user.daily_digest_time ?? DEFAULT_DELIVERY_MINUTES,
		user.timezone,
		currentTime,
	);
	const nextSendAtIso = nextSendAt?.toISO() ?? null;

	const { error } = await supabase
		.from("users")
		.update({ asset_events_next_send_at: nextSendAtIso })
		.eq("id", user.id);

	if (error) {
		logger.error(
			nextSendAtIso
				? "Failed to update users.asset_events_next_send_at"
				: "Failed to clear users.asset_events_next_send_at",
			{ userId: user.id, asset_events_next_send_at: nextSendAtIso },
			error,
		);
	}
}
