import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../constants";
import type { Logger } from "../../logging";
import { asMinuteOfDay, type MinuteOfDay } from "../../types";
import { parseTimeToMinutes } from "../parse";

function buildLocalDateTime(options: {
	date: DateTime;
	zone: string;
	hour: number;
	minute: number;
}): DateTime {
	const { date, zone, hour, minute } = options;
	return DateTime.fromObject(
		{
			year: date.year,
			month: date.month,
			day: date.day,
			hour,
			minute,
			second: 0,
			millisecond: 0,
		},
		{ zone },
	);
}

// Prefer the later offset when a local time is ambiguous (DST fall-back)
function pickLaterOffset(candidate: DateTime): DateTime {
	const possibleOffsets = candidate.getPossibleOffsets();
	if (possibleOffsets.length <= 1) {
		return candidate;
	}

	return possibleOffsets[possibleOffsets.length - 1] ?? candidate;
}

/**
 * Compute the next UTC send time for an ET minute-of-day.
 *
 * Operates on ET-canonical minutes (minutes since midnight in
 * America/New_York). DST ambiguity is handled for ET's own transitions by
 * preferring the later offset on fall-back days. Callers convert from
 * user-local minutes via `userLocalToEtMinute` at the boundary.
 *
 * Returns `null` when inputs are invalid or the ET zone cannot be resolved.
 */
export function calculateNextSendAt(etMinutes: number, now: DateTime): DateTime | null {
	if (!Number.isFinite(etMinutes)) {
		return null;
	}

	const hours = Math.floor(etMinutes / 60);
	const minutes = etMinutes % 60;
	if (
		!Number.isInteger(hours) ||
		!Number.isInteger(minutes) ||
		hours < 0 ||
		hours > 23 ||
		minutes < 0 ||
		minutes > 59
	) {
		return null;
	}

	const current = now.setZone(US_MARKET_TIMEZONE);
	if (!current.isValid) {
		return null;
	}

	let candidate = buildLocalDateTime({
		date: current,
		zone: US_MARKET_TIMEZONE,
		hour: hours,
		minute: minutes,
	});
	candidate = pickLaterOffset(candidate);

	if (!candidate.isValid) {
		return null;
	}

	if (candidate <= current) {
		candidate = candidate.plus({ days: 1 });
		candidate = pickLaterOffset(candidate);
		if (!candidate.isValid) {
			return null;
		}
	}

	return candidate.toUTC();
}

/**
 * Compute the next UTC send time across multiple ET minute-of-day candidates.
 *
 * Returns the earliest next send time, or `null` when no valid candidates exist.
 */
export function calculateNextSendAtFromTimes(
	etMinutesList: number[],
	now: DateTime,
): DateTime | null {
	if (!Array.isArray(etMinutesList) || etMinutesList.length === 0) {
		return null;
	}

	let nextSend: DateTime | null = null;
	for (const etMinutes of etMinutesList) {
		if (!Number.isFinite(etMinutes)) {
			continue;
		}
		const candidate = calculateNextSendAt(etMinutes, now);
		if (!candidate) {
			continue;
		}
		if (!nextSend || candidate < nextSend) {
			nextSend = candidate;
		}
	}

	return nextSend;
}

/**
 * Convert a DateTime into local minutes since midnight for the given timezone.
 *
 * Returns `null` when the timezone conversion is invalid.
 */
export function getLocalMinutesFromDateTime(timezone: string, date: DateTime): MinuteOfDay | null {
	const local = date.setZone(timezone);
	if (!local.isValid) {
		return null;
	}

	return asMinuteOfDay(local.hour * 60 + local.minute);
}

type ScheduledTimesParseResult = { ok: true; times: number[] } | { ok: false; reason: string };

/**
 * Parse `<input type="time">` string values into unique minutes-since-midnight values.
 */
export function parseScheduledTimes(values: string[]): ScheduledTimesParseResult {
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
	context: Record<string, unknown>,
	logger?: Logger,
): string {
	const nextSendAt = calculateNextSendAtFromTimes(times, DateTime.utc());
	if (!nextSendAt) {
		logger?.error("calculateNextSendAtFromTimes returned null", context);
		throw new Error(
			`Failed to compute market_scheduled_asset_price_next_send_at: ${JSON.stringify(context)}`,
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
		logger?.error("Failed to format market_scheduled_asset_price_next_send_at to ISO", detail);
		throw new Error(
			`Failed to format market_scheduled_asset_price_next_send_at: ${JSON.stringify(detail)}`,
		);
	}

	return iso;
}
