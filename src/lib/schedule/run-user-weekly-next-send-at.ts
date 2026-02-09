import { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

const DEFAULT_DELIVERY_MINUTES = 540; // 9:00 AM

/**
 * Calculate the next Monday send time in UTC.
 *
 * - Finds the next Monday after `now` in the user's timezone
 * - Sets time to `localMinutes` (falls back to 9 AM / 540 if unset)
 * - Converts to UTC
 */
export function calculateNextMondaySendAt(
	localMinutes: number | null,
	timezone: string,
	now: DateTime,
): DateTime | null {
	const minutes = localMinutes ?? DEFAULT_DELIVERY_MINUTES;
	if (!Number.isFinite(minutes)) return null;

	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return null;

	const current = now.setZone(timezone);
	if (!current.isValid) return null;

	// Find next Monday (weekday 1 in Luxon)
	const daysUntilMonday = (1 - current.weekday + 7) % 7 || 7;
	const targetDay = current.plus({ days: daysUntilMonday });

	let candidate = DateTime.fromObject(
		{
			year: targetDay.year,
			month: targetDay.month,
			day: targetDay.day,
			hour: hours,
			minute: mins,
			second: 0,
			millisecond: 0,
		},
		{ zone: timezone },
	);

	if (!candidate.isValid) return null;

	// Handle DST: prefer the later offset for ambiguous times
	const possibleOffsets = candidate.getPossibleOffsets();
	if (possibleOffsets.length > 1) {
		candidate = possibleOffsets[possibleOffsets.length - 1];
	}

	if (!candidate.isValid) return null;

	return candidate.toUTC();
}

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
		user.weekly_include_earnings || user.weekly_include_dividends;

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
		user.daily_delivery_time,
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
