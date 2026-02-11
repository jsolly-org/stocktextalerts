import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { parseTimeToMinutes } from "../time/format";
import { calculateNextSendAtFromTimes } from "../time/scheduled-times";

type ScheduledTimesParseResult =
	| { ok: true; times: number[] }
	| { ok: false; reason: string };

/**
 * Parse `<input type="time">` string values into unique minutes-since-midnight values.
 */
export function parseScheduledTimes(
	values: string[],
): ScheduledTimesParseResult {
	const minutes: number[] = [];
	for (const value of values) {
		const parsed = parseTimeToMinutes(value);
		if (parsed === null) {
			return { ok: false, reason: "invalid_time" };
		}
		minutes.push(parsed);
	}

	const unique = [...new Set(minutes)].sort((a, b) => a - b);
	return { ok: true, times: unique };
}

/**
 * Serialize a list of minutes-since-midnight into a stable comma-separated string.
 */
export function serializeTimes(times: number[] | null | undefined): string {
	if (!times || times.length === 0) {
		return "";
	}
	return [...times].sort((a, b) => a - b).join(",");
}

/**
 * Compute the next send time in ISO-UTC for scheduled notifications.
 *
 * Throws on failure (invalid inputs or unexpected null results) and logs contextual details.
 */
export function computeNextSendAtIso(
	times: number[],
	timezone: string,
	context: Record<string, unknown>,
	logger?: Logger,
): string {
	const nextSendAt = calculateNextSendAtFromTimes(
		times,
		timezone,
		DateTime.utc(),
	);
	if (!nextSendAt) {
		logger?.warn("calculateNextSendAtFromTimes returned null", context);
		throw new Error(
			`Failed to compute next_send_at: ${JSON.stringify(context)}`,
		);
	}

	const iso = nextSendAt.toISO();
	if (!iso) {
		const detail = {
			...context,
			nextSendAt: nextSendAt.toString(),
			nextSendAtIsValid: nextSendAt.isValid,
			nextSendAtInvalidReason: nextSendAt.invalidReason,
		};
		logger?.warn("Failed to format next_send_at to ISO", detail);
		throw new Error(`Failed to format next_send_at: ${JSON.stringify(detail)}`);
	}

	return iso;
}
