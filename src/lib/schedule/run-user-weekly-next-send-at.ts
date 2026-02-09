import { DateTime, FixedOffsetZone } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "./helpers";

const DEFAULT_DELIVERY_MINUTES = 540; // 9:00 AM

/**
 * Calculate the next Monday send time in UTC.
 *
 * - Finds the next Monday on/after `now` in the user's timezone
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

	/**
	 * Build a local-time candidate DateTime for a given calendar day.
	 *
	 * Handles DST ambiguity by choosing the later possible instant for the same wall time.
	 */
	function buildCandidateFromDay(day: DateTime): DateTime | null {
		const candidateLocal = {
			year: day.year,
			month: day.month,
			day: day.day,
			hour: hours,
			minute: mins,
			second: 0,
			millisecond: 0,
		};

		let candidate = DateTime.fromObject(candidateLocal, { zone: timezone });
		if (!candidate.isValid) return null;

		// Handle DST ambiguity: pick the later possible instant for the same wall time.
		const possibleOffsets = candidate.getPossibleOffsets() as unknown;
		if (Array.isArray(possibleOffsets) && possibleOffsets.length > 1) {
			const first = (possibleOffsets as unknown[])[0];

			// Luxon returns DateTime[]; to be defensive, also handle number[] offsets if surfaced.
			if (typeof first === "number") {
				const offsets = possibleOffsets as unknown as number[];
				const candidates = offsets.map((offset) =>
					candidate
						.setZone(FixedOffsetZone.instance(offset), { keepLocalTime: true })
						.setZone(timezone),
				);
				candidate = candidates.reduce((latest, dt) =>
					dt.toMillis() > latest.toMillis() ? dt : latest,
				);
			} else {
				const possible = possibleOffsets as unknown as DateTime[];
				candidate = possible.reduce((latest, dt) =>
					dt.toMillis() > latest.toMillis() ? dt : latest,
				);
			}
		}

		return candidate.isValid ? candidate : null;
	}

	// Find Monday (weekday 1 in Luxon). Allow "today" (0 days) if it's Monday.
	const daysUntilMonday = (1 - current.weekday + 7) % 7;
	let targetDay = current.plus({ days: daysUntilMonday });

	let candidate = buildCandidateFromDay(targetDay);
	if (!candidate) return null;

	// If today's Monday time has already passed (or is exactly now), advance to next week.
	if (candidate.toMillis() <= current.toMillis()) {
		targetDay = targetDay.plus({ days: 7 });
		candidate = buildCandidateFromDay(targetDay);
		if (!candidate) return null;
	}

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
