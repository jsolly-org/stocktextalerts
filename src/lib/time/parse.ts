import { DateTime } from "luxon";
import {
	asHour24,
	asMinuteOfDay,
	asMinuteOfHour,
	asSecondOfMinute,
	type MinuteOfDay,
} from "../types";
import type { ParsedTime } from "./types";

export function parseTimeToMinutes(value: string): MinuteOfDay | null {
	if (!/^\d+:\d+$/.test(value)) {
		return null;
	}

	const dt = DateTime.fromFormat(value, "H:m", { zone: "utc" });
	if (!dt.isValid || dt.hour > 23 || dt.minute > 59) {
		return null;
	}

	return asMinuteOfDay(dt.hour * 60 + dt.minute);
}

export function parseTimeString(value: string | null | undefined): ParsedTime | null {
	if (!value) {
		return null;
	}

	if (/^\d+:\d+:\d+$/.test(value)) {
		const dt = DateTime.fromFormat(value, "H:m:s", { zone: "utc" });
		if (!dt.isValid || dt.hour > 23 || dt.minute > 59 || dt.second > 59) {
			return null;
		}
		const hours = asHour24(dt.hour);
		const minutes = asMinuteOfHour(dt.minute);
		const seconds = asSecondOfMinute(dt.second);
		if (hours === null || minutes === null || seconds === null) {
			return null;
		}
		return { hours, minutes, seconds };
	}

	if (/^\d+:\d+$/.test(value)) {
		const dt = DateTime.fromFormat(value, "H:m", { zone: "utc" });
		if (!dt.isValid || dt.hour > 23 || dt.minute > 59) {
			return null;
		}
		const hours = asHour24(dt.hour);
		const minutes = asMinuteOfHour(dt.minute);
		const seconds = asSecondOfMinute(0);
		if (hours === null || minutes === null || seconds === null) {
			return null;
		}
		return { hours, minutes, seconds };
	}

	return null;
}
