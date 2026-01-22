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

	if (!candidate.isValid) {
		return null;
	}

	if (candidate <= current) {
		candidate = candidate.plus({ days: 1 });
		if (!candidate.isValid) {
			return null;
		}
	}

	return candidate.toUTC();
}
