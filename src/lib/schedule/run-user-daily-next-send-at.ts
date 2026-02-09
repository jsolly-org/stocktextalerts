import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import { calculateNextSendAt } from "../time/scheduled-times";
import type { SupabaseAdminClient } from "./helpers";

// Recompute because timezone/DST offsets can shift the user's intended local delivery time.
export async function updateUserDailyNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	const { user, supabase, logger, currentTime } = options;

	if (user.daily_delivery_time === null) {
		const { error } = await supabase
			.from("users")
			.update({ daily_next_send_at: null })
			.eq("id", user.id);
		if (error) {
			logger.error(
				"Failed to clear users.daily_next_send_at",
				{ userId: user.id },
				error,
			);
		}
		return;
	}

	const nextSendAt = calculateNextSendAt(
		user.daily_delivery_time,
		user.timezone,
		currentTime,
	);
	const nextSendAtIso = nextSendAt?.toISO() ?? null;

	const { error } = await supabase
		.from("users")
		.update({ daily_next_send_at: nextSendAtIso })
		.eq("id", user.id);

	if (error) {
		logger.error(
			nextSendAtIso
				? "Failed to update users.daily_next_send_at"
				: "Failed to clear users.daily_next_send_at",
			{ userId: user.id, daily_next_send_at: nextSendAtIso },
			error,
		);
	}
}
