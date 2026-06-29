import { DateTime } from "luxon";

export function clampMinuteOfDay(minutes: number): number {
	const safeMinutes = Number.isFinite(minutes) ? minutes : 0;
	return Math.max(0, Math.min(1439, Math.floor(safeMinutes)));
}

/** Wall-clock time on the anchor's calendar day at `minutes` since midnight. */
export function dateTimeAtMinuteOfDay(minutes: number, zone?: string, anchor?: DateTime): DateTime {
	const base = (anchor ?? DateTime.now()).setZone(zone);
	const hour = Math.floor(minutes / 60);
	const minute = minutes % 60;
	return base.startOf("day").set({ hour, minute, second: 0, millisecond: 0 });
}

export function minuteOfDayFromDateTime(dateTime: DateTime): number {
	return dateTime.hour * 60 + dateTime.minute;
}
