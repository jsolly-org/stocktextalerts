import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import { calculateNextMondaySendAt } from "../time/scheduled-times";
import type { SupabaseAdminClient } from "./helpers";

const DEFAULT_DELIVERY_MINUTES = 540; // 9:00 AM

/**
 * Recompute and persist `users.weekly_next_send_at` for a user.
 *
 * Clears the field when weekly options are disabled, otherwise calculates the next Monday send
 * timestamp (in UTC) using the user's timezone and preferred local delivery time.
 */
export async function updateUserWeeklyNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	const { user, supabase, logger, currentTime } = options;

	const hasWeeklyOption =
		user.weekly_include_earnings_email || user.weekly_include_earnings_sms;

	if (!hasWeeklyOption) {
		const { error } = await supabase
			.from("users")
			.update({ weekly_next_send_at: null })
			.eq("id", user.id);
		if (error) {
			logger.error(
				"Failed to clear users.weekly_next_send_at",
				{ userId: user.id },
				error,
			);
		}
		return;
	}

	const nextSendAt = calculateNextMondaySendAt(
		user.daily_delivery_time ?? DEFAULT_DELIVERY_MINUTES,
		user.timezone,
		currentTime,
	);
	const nextSendAtIso = nextSendAt?.toISO() ?? null;

	const { error } = await supabase
		.from("users")
		.update({ weekly_next_send_at: nextSendAtIso })
		.eq("id", user.id);

	if (error) {
		logger.error(
			nextSendAtIso
				? "Failed to update users.weekly_next_send_at"
				: "Failed to clear users.weekly_next_send_at",
			{ userId: user.id, weekly_next_send_at: nextSendAtIso },
			error,
		);
	}
}
