import { DateTime, Duration } from "luxon";
import type { MinuteOfDay } from "../types";
import { userLocalToEtMinute } from "./conversion";
import { parseTimeToMinutes } from "./parse";
import { calculateNextSendAt, calculateNextSendAtFromTimes } from "./schedule/next-send";
import type { TimeValue } from "./types";
import { clampMinuteOfDay, dateTimeAtMinuteOfDay } from "./utils";

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

export function minutesToTimeInputValue(minutes: number): string {
	return dateTimeAtMinuteOfDay(clampMinuteOfDay(minutes)).toFormat("HH:mm");
}

export function formatTimeValue(value: TimeValue): string {
	const hours = typeof value.hours === "string" ? Number.parseInt(value.hours, 10) : value.hours;
	const minutes =
		typeof value.minutes === "string" ? Number.parseInt(value.minutes, 10) : value.minutes;
	const h = Number.isNaN(hours) ? 0 : Math.max(0, Math.min(23, Math.floor(hours)));
	const m = Number.isNaN(minutes) ? 0 : Math.max(0, Math.min(59, Math.floor(minutes)));
	return DateTime.fromObject({ hour: h, minute: m }).toFormat("HH:mm");
}

// Fallback when no stored user preference; stored use_24_hour_time is primary.
export function resolveIs24(): boolean {
	const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
	const { hourCycle } = formatter.resolvedOptions();
	return hourCycle === "h23" || hourCycle === "h24";
}

export function getNowInTimezone(timezone: string, is24?: boolean): string | null {
	const now = DateTime.now().setZone(timezone);
	if (!now.isValid) {
		return null;
	}

	if (is24 === true) {
		return now.toLocaleString(DateTime.TIME_24_WITH_SECONDS);
	}
	if (is24 === false) {
		return now.toLocaleString({
			...DateTime.TIME_WITH_SECONDS,
			hourCycle: "h12",
		});
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

	if (typeof options.nextSendAtIso === "string" && options.nextSendAtIso !== "") {
		const nextSendAt = DateTime.fromISO(options.nextSendAtIso, { zone: "utc" });
		if (!nextSendAt.isValid) {
			return null;
		}
		const diffSeconds = Math.ceil(nextSendAt.diff(now.toUTC(), "seconds").seconds);
		if (Number.isFinite(diffSeconds) && diffSeconds > 0) {
			return diffSeconds;
		}
		// next_send_at is in the past (e.g. update just sent); fall back to
		// delivery times so the UI can show countdown to the next occurrence.
	}

	if (Array.isArray(options.timeInputs) && options.timeInputs.length > 0) {
		const localMinutes = options.timeInputs
			.map((value) => parseTimeToMinutes(value))
			.filter((value): value is MinuteOfDay => value !== null);
		if (localMinutes.length === 0) {
			return null;
		}

		const etMinutes = localMinutes.map((m) => userLocalToEtMinute(m, options.timezone));
		const nextSendAt = calculateNextSendAtFromTimes(etMinutes, now);
		if (!nextSendAt) {
			return null;
		}

		const diffSeconds = Math.ceil(nextSendAt.diff(now.toUTC(), "seconds").seconds);
		if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
			return null;
		}
		return diffSeconds;
	}

	if (typeof options.timeInput === "string" && options.timeInput !== "") {
		const localDeliveryMinutes = parseTimeToMinutes(options.timeInput);
		if (localDeliveryMinutes === null) {
			return null;
		}

		const etMinutes = userLocalToEtMinute(localDeliveryMinutes, options.timezone);
		const nextSendAt = calculateNextSendAt(etMinutes, now);
		if (!nextSendAt) {
			return null;
		}

		const diffSeconds = Math.ceil(nextSendAt.diff(now.toUTC(), "seconds").seconds);
		if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
			return null;
		}
		return diffSeconds;
	}

	return null;
}

/* =============
Format minute-of-day for UI display in the runtime locale
============= */
export function formatMinutesAsLocalTime(minutes: number, is24?: boolean): string {
	const dt = dateTimeAtMinuteOfDay(clampMinuteOfDay(minutes));
	if (is24 === true) {
		return dt.toLocaleString(DateTime.TIME_24_SIMPLE);
	}
	if (is24 === false) {
		return dt.toLocaleString({
			...DateTime.TIME_SIMPLE,
			hourCycle: "h12",
		});
	}
	return dt.toLocaleString(DateTime.TIME_SIMPLE);
}
