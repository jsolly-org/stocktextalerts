import { DateTime } from "luxon";
import { rootLogger } from "../logging";

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

function pickLaterOffset(candidate: DateTime): DateTime {
	const possibleOffsets = candidate.getPossibleOffsets();
	if (possibleOffsets.length <= 1) {
		return candidate;
	}

	return possibleOffsets[possibleOffsets.length - 1];
}

export function getLocalDateString(
	timezone: string,
	date: DateTime,
): string | null {
	const local = date.setZone(timezone);
	if (!local.isValid) {
		rootLogger.error("Failed to format local date for timezone", { timezone });
		return null;
	}

	return local.toISODate();
}

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
