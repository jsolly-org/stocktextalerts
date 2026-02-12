import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { calculateNextSendAt } from "../time/scheduled-times";

// Recompute because timezone/DST offsets can shift the user's intended local delivery time.
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
	const { user, supabase, logger, currentTime } = options;

	if (user.daily_digest_time === null) {
		const { error } = await supabase
			.from("users")
			.update({ daily_digest_next_send_at: null })
			.eq("id", user.id);
		if (error) {
			logger.error(
				"Failed to clear users.daily_digest_next_send_at",
				{ userId: user.id },
				error,
			);
		}
		return;
	}

	const nextSendAt = calculateNextSendAt(
		user.daily_digest_time,
		user.timezone,
		currentTime,
	);
	const nextSendAtIso = nextSendAt?.toISO() ?? null;

	const { error } = await supabase
		.from("users")
		.update({ daily_digest_next_send_at: nextSendAtIso })
		.eq("id", user.id);

	if (error) {
		logger.error(
			nextSendAtIso
				? "Failed to update users.daily_digest_next_send_at"
				: "Failed to clear users.daily_digest_next_send_at",
			{ userId: user.id, daily_digest_next_send_at: nextSendAtIso },
			error,
		);
	}
}
