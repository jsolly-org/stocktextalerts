import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../src/lib/constants";

/** Polygon snapshot `updated` field: nanoseconds from Unix seconds (safe integer literal). */
export function polygonUpdatedNs(unixSeconds: number): number {
	return unixSeconds * 1_000_000_000;
}

/** Weekday ISO dates between two calendar dates in US market timezone (Mon–Fri). */
export function listTradingDatesBetween(from: string, to: string): string[] {
	const start = DateTime.fromISO(from, { zone: US_MARKET_TIMEZONE });
	const end = DateTime.fromISO(to, { zone: US_MARKET_TIMEZONE });
	if (!start.isValid || !end.isValid) return [];
	const dates: string[] = [];
	let day = start.startOf("day");
	const endDay = end.startOf("day");
	while (day <= endDay) {
		if (day.weekday <= 5) {
			const iso = day.toISODate();
			if (iso) dates.push(iso);
		}
		day = day.plus({ days: 1 });
	}
	return dates;
}
