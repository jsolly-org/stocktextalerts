import type { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { calculateNextSendAt } from "./scheduled-times";

/**
 * Recompute and persist a user's single-time next_send_at column.
 *
 * When `getLocalMinutes` returns null, the column is cleared. Otherwise the next UTC
 * send time is calculated and stored. Reduces duplication between asset-events and daily-digest.
 */
export async function updateUserNextSendAtSingleTime(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	column: "asset_events_next_send_at" | "daily_digest_next_send_at";
	getLocalMinutes: (user: UserRecord) => number | null;
}): Promise<void> {
	const { user, supabase, logger, currentTime, column, getLocalMinutes } =
		options;

	const localMinutes = getLocalMinutes(user);
	if (localMinutes === null) {
		const { error } = await supabase
			.from("users")
			.update({ [column]: null })
			.eq("id", user.id);
		if (error) {
			logger.error(
				`Failed to clear users.${column}`,
				{ userId: user.id },
				error,
			);
		}
		return;
	}

	const nextSendAt = calculateNextSendAt(
		localMinutes,
		user.timezone,
		currentTime,
	);
	const nextSendAtIso = nextSendAt?.toISO() ?? null;

	const { error } = await supabase
		.from("users")
		.update({ [column]: nextSendAtIso })
		.eq("id", user.id);

	if (error) {
		logger.error(
			nextSendAtIso
				? `Failed to update users.${column}`
				: `Failed to clear users.${column}`,
			{ userId: user.id, [column]: nextSendAtIso },
			error,
		);
	}
}
