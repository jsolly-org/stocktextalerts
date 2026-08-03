/**
 * FINRA equity short-interest settlement and publication calendar.
 *
 * Firms report as of mid-month (15th or preceding weekday) and month-end
 * (last weekday). FINRA publishes on the 7th weekday after settlement.
 * Weekday-only (Mon–Fri) is used as the business-day approximation.
 */
import { DateTime } from "luxon";

export type FinraShortInterestCycle = {
	settlementDate: string;
	publishDate: string;
};

function isWeekday(dt: DateTime): boolean {
	return dt.weekday >= 1 && dt.weekday <= 5;
}

/** Previous weekday on or before `dt` (Mon–Fri). */
export function previousWeekdayOnOrBefore(dt: DateTime): DateTime {
	let cursor = dt.startOf("day");
	while (!isWeekday(cursor)) {
		cursor = cursor.minus({ days: 1 });
	}
	return cursor;
}

/** Add `n` weekdays after `dt` (n >= 1). Day 1 = next weekday after `dt`. */
export function addWeekdays(dt: DateTime, n: number): DateTime {
	let cursor = dt.startOf("day");
	let remaining = n;
	while (remaining > 0) {
		cursor = cursor.plus({ days: 1 });
		if (isWeekday(cursor)) {
			remaining -= 1;
		}
	}
	return cursor;
}

function midMonthSettlement(year: number, month: number): DateTime {
	return previousWeekdayOnOrBefore(DateTime.utc(year, month, 15));
}

function monthEndSettlement(year: number, month: number): DateTime {
	const lastDay = DateTime.utc(year, month, 1).endOf("month").startOf("day");
	return previousWeekdayOnOrBefore(lastDay);
}

function cycleFromSettlement(settlement: DateTime): FinraShortInterestCycle {
	const publish = addWeekdays(settlement, 7);
	const settlementDate = settlement.toISODate();
	const publishDate = publish.toISODate();
	if (!settlementDate || !publishDate) {
		throw new Error("Failed to format FINRA short-interest cycle dates");
	}
	return { settlementDate, publishDate };
}

/** All mid-month + month-end cycles whose publish date falls in `[fromIso, toIso]` (inclusive). */
export function listFinraShortInterestCyclesInRange(
	fromIso: string,
	toIso: string,
): FinraShortInterestCycle[] {
	const from = DateTime.fromISO(fromIso, { zone: "utc" }).startOf("day");
	const to = DateTime.fromISO(toIso, { zone: "utc" }).startOf("day");
	if (!from.isValid || !to.isValid || to < from) {
		return [];
	}

	const cycles: FinraShortInterestCycle[] = [];
	// Walk months from one before `from` through one after `to` so mid/month-end
	// settlements near boundaries are included.
	let monthCursor = from.startOf("month").minus({ months: 1 });
	const monthEnd = to.startOf("month").plus({ months: 1 });

	while (monthCursor <= monthEnd) {
		const y = monthCursor.year;
		const m = monthCursor.month;
		for (const settlement of [midMonthSettlement(y, m), monthEndSettlement(y, m)]) {
			const cycle = cycleFromSettlement(settlement);
			if (cycle.publishDate >= fromIso && cycle.publishDate <= toIso) {
				cycles.push(cycle);
			}
		}
		monthCursor = monthCursor.plus({ months: 1 });
	}

	cycles.sort((a, b) => a.publishDate.localeCompare(b.publishDate));
	return cycles;
}

/**
 * Next FINRA short-interest publish cycle on or after `localDate`
 * (ISO date in the user's local calendar).
 */
export function getNextFinraShortInterestCycle(localDate: string): FinraShortInterestCycle | null {
	const start = DateTime.fromISO(localDate, { zone: "utc" });
	if (!start.isValid) return null;
	const fromIso = start.toISODate();
	const toIso = start.plus({ months: 3 }).toISODate();
	if (!fromIso || !toIso) return null;
	const cycles = listFinraShortInterestCyclesInRange(fromIso, toIso);
	return cycles[0] ?? null;
}

/**
 * True when `publishDate` falls in the calendar 3-day lookahead
 * (`localDate` … `localDate + 2`), same window as earnings/div/split.
 */
export function isFinraPublishInCalendarWindow(localDate: string, publishDate: string): boolean {
	const local = DateTime.fromISO(localDate, { zone: "utc" }).startOf("day");
	const publish = DateTime.fromISO(publishDate, { zone: "utc" }).startOf("day");
	if (!local.isValid || !publish.isValid) return false;
	const end = local.plus({ days: 2 });
	return publish >= local && publish <= end;
}
