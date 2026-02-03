import { DateTime } from "luxon";
import { calculateNextSendAt, calculateNextSendAtFromTimes } from "./schedule";
import type { ParsedTime, TimeValue } from "./types";

export {
	formatArrivalTime,
	formatCountdownWithSeconds,
	formatTimeRemaining,
	formatTimezone,
} from "./format-countdown";

export function toIsoOrThrow(
	dateTime: DateTime,
	errorMessage = "Failed to format ISO string",
): string {
	const iso = dateTime.toISO();
	if (!iso) {
		throw new Error(errorMessage);
	}
	return iso;
}

export function parseTimeToMinutes(value: string): number | null {
	const parts = value.split(":");
	if (parts.length !== 2) {
		return null;
	}

	const hours = Number.parseInt(parts[0] ?? "", 10);
	const minutes = Number.parseInt(parts[1] ?? "", 10);

	if (
		Number.isNaN(hours) ||
		Number.isNaN(minutes) ||
		hours < 0 ||
		hours > 23 ||
		minutes < 0 ||
		minutes > 59
	) {
		return null;
	}

	return hours * 60 + minutes;
}

export function parseTimeString(
	value: string | null | undefined,
): ParsedTime | null {
	if (!value) {
		return null;
	}

	const parts = value.split(":");
	if (parts.length !== 2 && parts.length !== 3) {
		return null;
	}

	const [hoursPart, minutesPart, secondsPart] = parts;
	if (!hoursPart || !minutesPart) {
		return null;
	}

	if (!/^\d+$/.test(hoursPart) || !/^\d+$/.test(minutesPart)) {
		return null;
	}

	const hours = Number.parseInt(hoursPart, 10);
	const minutes = Number.parseInt(minutesPart, 10);

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

	if (parts.length === 2) {
		return { hours, minutes, seconds: 0 };
	}

	if (!secondsPart || !/^\d+$/.test(secondsPart)) {
		return null;
	}
	const seconds = Number.parseInt(secondsPart, 10);
	if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
		return null;
	}
	return { hours, minutes, seconds };
}

export function minutesToTimeInputValue(minutes: number): string {
	const clamped = Math.max(0, Math.min(1439, Math.floor(minutes)));
	const hours = Math.floor(clamped / 60);
	const mins = clamped % 60;
	return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function formatTimeValue(value: TimeValue): string {
	const hours =
		typeof value.hours === "string"
			? Number.parseInt(value.hours, 10)
			: value.hours;
	const minutes =
		typeof value.minutes === "string"
			? Number.parseInt(value.minutes, 10)
			: value.minutes;
	const h = Number.isNaN(hours)
		? 0
		: Math.max(0, Math.min(23, Math.floor(hours)));
	const m = Number.isNaN(minutes)
		? 0
		: Math.max(0, Math.min(59, Math.floor(minutes)));
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function resolveIs24(): boolean {
	const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
	const options = formatter.resolvedOptions();
	return options.hourCycle === "h23" || options.hourCycle === "h24";
}

export function getNowInTimezone(timezone: string): string | null {
	const now = DateTime.now().setZone(timezone);
	if (!now.isValid) {
		return null;
	}

	return now.toLocaleString(DateTime.TIME_WITH_SECONDS);
}

export function getSecondsUntilNextSend(options: {
	timezone: string;
	nextSendAtIso?: string | null;
	timeInput?: string | null;
	timeInputs?: string[] | null;
	now?: DateTime;
}): number | null {
	const now = options.now ?? DateTime.now();

	if (
		typeof options.nextSendAtIso === "string" &&
		options.nextSendAtIso !== ""
	) {
		const nextSendAt = DateTime.fromISO(options.nextSendAtIso, { zone: "utc" });
		if (!nextSendAt.isValid) {
			return null;
		}
		const diffSeconds = Math.ceil(
			nextSendAt.diff(now.toUTC(), "seconds").seconds,
		);
		if (Number.isFinite(diffSeconds) && diffSeconds > 0) {
			return diffSeconds;
		}
		// next_send_at is in the past (e.g. digest just sent); fall back to
		// delivery times so the UI can show countdown to the next occurrence.
	}

	if (Array.isArray(options.timeInputs) && options.timeInputs.length > 0) {
		const minutes = options.timeInputs
			.map((value) => parseTimeToMinutes(value))
			.filter((value): value is number => value !== null);
		if (minutes.length === 0) {
			return null;
		}

		const nextSendAt = calculateNextSendAtFromTimes(
			minutes,
			options.timezone,
			now,
		);
		if (!nextSendAt) {
			return null;
		}

		const diffSeconds = Math.ceil(
			nextSendAt.diff(now.toUTC(), "seconds").seconds,
		);
		if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
			return null;
		}
		return diffSeconds;
	}

	if (typeof options.timeInput === "string" && options.timeInput !== "") {
		const deliveryMinutes = parseTimeToMinutes(options.timeInput);
		if (deliveryMinutes === null) {
			return null;
		}

		const nextSendAt = calculateNextSendAt(
			deliveryMinutes,
			options.timezone,
			now,
		);
		if (!nextSendAt) {
			return null;
		}

		const diffSeconds = Math.ceil(
			nextSendAt.diff(now.toUTC(), "seconds").seconds,
		);
		if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
			return null;
		}
		return diffSeconds;
	}

	return null;
}

export function formatNextSendDateTime(
	nextSendAtIso: string,
	timezone: string,
): string {
	const dt = DateTime.fromISO(nextSendAtIso, { zone: "utc" }).setZone(timezone);
	if (!dt.isValid) {
		return "";
	}
	return dt.toFormat("MMMM d 'at' HH:mm:ss");
}
