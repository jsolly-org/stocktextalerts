import { DateTime } from "luxon";

/**
 * Build a local DateTime for the given date in a specific zone.
 */
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

/**
 * Prefer the later possible offset when a local time is ambiguous (DST fall-back).
 */
function pickLaterOffset(candidate: DateTime): DateTime {
	const possibleOffsets = candidate.getPossibleOffsets();
	if (possibleOffsets.length <= 1) {
		return candidate;
	}

	return possibleOffsets[possibleOffsets.length - 1];
}

/**
 * Calculate the next UTC send timestamp for a single local minutes value.
 */
export function calculateNextSendAt(
	localMinutes: number,
	timezone: string,
	now: DateTime,
): DateTime | null {
	if (!Number.isFinite(localMinutes)) {
		return null;
	}

	const hours = Math.floor(localMinutes / 60);
	const minutes = localMinutes % 60;
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

	const current = now.setZone(timezone);
	if (!current.isValid) {
		return null;
	}

	let candidate = buildLocalDateTime({
		date: current,
		zone: timezone,
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
 * Calculate the earliest next UTC send timestamp across multiple local minutes values.
 */
export function calculateNextSendAtFromTimes(
	localMinutesList: number[],
	timezone: string,
	now: DateTime,
): DateTime | null {
	if (!Array.isArray(localMinutesList) || localMinutesList.length === 0) {
		return null;
	}

	let nextSend: DateTime | null = null;
	for (const localMinutes of localMinutesList) {
		if (!Number.isFinite(localMinutes)) {
			continue;
		}
		const candidate = calculateNextSendAt(localMinutes, timezone, now);
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
 * Convert a UTC DateTime into minutes since midnight in the provided timezone.
 */
export function getLocalMinutesFromDateTime(
	timezone: string,
	date: DateTime,
): number | null {
	const local = date.setZone(timezone);
	if (!local.isValid) {
		return null;
	}

	return local.hour * 60 + local.minute;
}
