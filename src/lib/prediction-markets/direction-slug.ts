import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";

const MONTH_SLUG = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
] as const;

/**
 * Polymarket daily direction slug for a ticker + ET calendar session.
 * Example: PLTR + 2026-07-31 → `pltr-up-or-down-on-july-31-2026`
 */
export function polymarketDailyDirectionSlug(symbol: string, sessionDateEt: string): string | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sessionDateEt);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
	const monthName = MONTH_SLUG[month - 1];
	if (!monthName) return null;
	const sym = symbol
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	if (!sym) return null;
	return `${sym}-up-or-down-on-${monthName}-${day}-${year}`;
}

/**
 * Next ET weekdays strictly after today (skips Sat/Sun). Holidays are handled
 * by probing a few candidates — missing slugs simply return null from Gamma.
 */
export function nextEtWeekdayDates(options: { nowMs?: number; count?: number }): string[] {
	const count = options.count ?? 3;
	let cursor = DateTime.fromMillis(options.nowMs ?? Date.now(), { zone: "utc" }).setZone(
		US_MARKET_TIMEZONE,
	);
	if (!cursor.isValid) return [];
	const out: string[] = [];
	// Start at tomorrow ET.
	cursor = cursor.startOf("day").plus({ days: 1 });
	for (let i = 0; i < 14 && out.length < count; i++) {
		// Luxon: 1=Mon … 7=Sun
		if (cursor.weekday <= 5) {
			const iso = cursor.toISODate();
			if (iso) out.push(iso);
		}
		cursor = cursor.plus({ days: 1 });
	}
	return out;
}
