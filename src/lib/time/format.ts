import { DateTime, Duration } from "luxon";
import {
	US_MARKET_CLOSE_EASTERN_MINUTES,
	US_MARKET_OPEN_EASTERN_MINUTES,
	US_MARKET_TIMEZONE,
} from "../constants";
import {
	calculateNextSendAt,
	calculateNextSendAtFromTimes,
} from "./scheduled-times";
import type { ParsedTime, TimeValue } from "./types";

/**
 * Format a human-readable countdown string (hours/minutes/seconds) from a seconds value.
 *
 * Negative values are clamped to 0.
 */
export function formatCountdownWithSeconds(secondsUntil: number): string {
	const safeSeconds = Math.max(secondsUntil, 0);
	const duration = Duration.fromObject({ seconds: safeSeconds });
	const {
		hours = 0,
		minutes = 0,
		seconds = 0,
	} = duration.shiftTo("hours", "minutes", "seconds").normalize().toObject();
	const h = Math.trunc(hours);
	const m = Math.trunc(minutes);
	const s = Math.trunc(seconds);
	const parts: string[] = [];
	if (h > 0) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
	if (m > 0) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
	parts.push(`${s} ${s === 1 ? "second" : "seconds"}`);
	return parts.join(", ");
}

/**
 * Convert a Luxon DateTime to an ISO string, throwing when formatting fails.
 */
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

/**
 * Parse a `HH:MM` time string to minutes since midnight.
 *
 * Returns `null` for invalid inputs.
 */
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

/**
 * Parse a `HH:MM` or `HH:MM:SS` string into discrete parts.
 *
 * Returns `null` for invalid inputs.
 */
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

/**
 * Convert minutes since midnight into a `HH:MM` string suitable for `<input type="time">`.
 */
export function minutesToTimeInputValue(minutes: number): string {
	const clamped = Math.max(0, Math.min(1439, Math.floor(minutes)));
	const hours = Math.floor(clamped / 60);
	const mins = clamped % 60;
	return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * Normalize a time value (numbers or numeric strings) into a `HH:MM` string.
 *
 * Out-of-range/NaN values are clamped to a safe range.
 */
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

/**
 * Return true when the runtime locale uses a 24-hour clock.
 */
export function resolveIs24(): boolean {
	const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
	const options = formatter.resolvedOptions();
	return options.hourCycle === "h23" || options.hourCycle === "h24";
}

/**
 * Return the current local time (with seconds) in the given IANA timezone.
 *
 * Returns `null` when the timezone is invalid.
 */
export function getNowInTimezone(timezone: string): string | null {
	const now = DateTime.now().setZone(timezone);
	if (!now.isValid) {
		return null;
	}

	return now.toLocaleString(DateTime.TIME_WITH_SECONDS);
}

/**
 * Compute the number of seconds until the next send time for a user.
 *
 * Prefers `next_send_at` when present and in the future; otherwise falls back to the configured
 * delivery time(s). Returns `null` when inputs are invalid or no schedule is configured.
 */
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
		// next_send_at is in the past (e.g. update just sent); fall back to
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

/* =============
Use Eastern-market baseline so local conversions stay aligned with exchange hours
============= */
/**
 * Convert US market open (9:30 AM ET) to the user's local minutes since midnight.
 */
export function getUsMarketOpenLocalMinutes(userTimezone: string): number {
	const marketOpenHour = Math.floor(US_MARKET_OPEN_EASTERN_MINUTES / 60);
	const marketOpenMinute = US_MARKET_OPEN_EASTERN_MINUTES % 60;
	const eastern = DateTime.now().setZone(US_MARKET_TIMEZONE).set({
		hour: marketOpenHour,
		minute: marketOpenMinute,
		second: 0,
		millisecond: 0,
	});
	const local = eastern.setZone(userTimezone);
	if (!local.isValid) {
		return US_MARKET_OPEN_EASTERN_MINUTES; // fallback to Eastern
	}
	return local.hour * 60 + local.minute;
}

/**
 * Convert US market close (4:00 PM ET) to the user's local minutes since midnight.
 */
export function getUsMarketCloseLocalMinutes(userTimezone: string): number {
	const marketCloseHour = Math.floor(US_MARKET_CLOSE_EASTERN_MINUTES / 60);
	const marketCloseMinute = US_MARKET_CLOSE_EASTERN_MINUTES % 60;
	const eastern = DateTime.now().setZone(US_MARKET_TIMEZONE).set({
		hour: marketCloseHour,
		minute: marketCloseMinute,
		second: 0,
		millisecond: 0,
	});
	const local = eastern.setZone(userTimezone);
	if (!local.isValid) {
		return US_MARKET_CLOSE_EASTERN_MINUTES; // fallback to Eastern
	}
	return local.hour * 60 + local.minute;
}

/**
 * Returns true when a local minute-of-day falls outside regular US market
 * hours (9:30 AM – 4:00 PM ET) converted to the user's timezone.
 */
export function isOutsideMarketHours(
	timeMinutes: number,
	userTimezone: string,
): boolean {
	const openLocal = getUsMarketOpenLocalMinutes(userTimezone);
	const closeLocal = getUsMarketCloseLocalMinutes(userTimezone);

	// When open < close (same calendar day), valid range is [open, close).
	// When open >= close (crosses midnight, e.g. far-east timezones),
	// valid range wraps: [open, 1440) ∪ [0, close).
	if (openLocal < closeLocal) {
		return timeMinutes < openLocal || timeMinutes >= closeLocal;
	}
	return timeMinutes >= closeLocal && timeMinutes < openLocal;
}

/* =============
Format minute-of-day for UI display in the runtime locale
============= */
/**
 * Format a minute-of-day value into a locale-aware time string.
 */
export function formatMinutesAsLocalTime(minutes: number): string {
	const clamped = Math.max(0, Math.min(1439, Math.floor(minutes)));
	const dt = DateTime.now().set({
		hour: Math.floor(clamped / 60),
		minute: clamped % 60,
		second: 0,
		millisecond: 0,
	});
	return dt.toLocaleString(DateTime.TIME_SIMPLE);
}
