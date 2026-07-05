import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../constants";
import { isRecord } from "../../types";
import { marketDataFetch } from "../../vendors/massive";

import type { MarketClosureInfo } from "../types";

type CalendarRecord =
	| { kind: "closed"; name?: string }
	| { kind: "early-close"; closeUtc: DateTime; name?: string };

const CALENDAR_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Brief negative cache when Massive `/v1/marketstatus/upcoming` fails — avoids hammering the API. */
const CALENDAR_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
let calendarCache: {
	expiresAt: number;
	records: Map<string, CalendarRecord>;
} | null = null;

/**
 * Fetch upcoming US market calendar (NYSE/NASDAQ): full closures AND half-days.
 * Half-days feed `getCurrentMarketSession`, which forces "closed" past the early
 * close (no extended trading session exists on a half-day), and the scheduled
 * notification gating that must not deliver during the half-day dead zone.
 */
async function fetchUsMarketCalendar(): Promise<Map<string, CalendarRecord>> {
	const now = Date.now();
	if (calendarCache && calendarCache.expiresAt > now) {
		return calendarCache.records;
	}

	const payload = await marketDataFetch("/v1/marketstatus/upcoming", {}, "market-holidays");

	if (!Array.isArray(payload)) {
		const staleRecords = calendarCache?.records ?? new Map<string, CalendarRecord>();
		calendarCache = {
			expiresAt: now + CALENDAR_FAILURE_CACHE_TTL_MS,
			records: staleRecords,
		};
		return staleRecords;
	}

	const records = new Map<string, CalendarRecord>();

	for (const row of payload) {
		if (!isRecord(row)) continue;
		const record = row;

		const exchange = typeof record.exchange === "string" ? record.exchange : "";
		const status = typeof record.status === "string" ? record.status : "";
		const date = typeof record.date === "string" ? record.date : "";
		const name = typeof record.name === "string" ? record.name.trim() : "";

		if (
			!(exchange.includes("NYSE") || exchange.includes("NASDAQ")) ||
			!/^\d{4}-\d{2}-\d{2}$/.test(date)
		) {
			continue;
		}

		if (status === "closed") {
			// Full-day closure trumps any concurrent early-close record from
			// another exchange — if either reports "closed", treat the day as closed.
			records.set(date, { kind: "closed", name: name || undefined });
		} else if (status === "early-close") {
			if (records.get(date)?.kind === "closed") continue;

			const closeRaw = typeof record.close === "string" ? record.close : "";
			const closeDt = closeRaw ? DateTime.fromISO(closeRaw, { zone: "utc" }) : null;
			if (!closeDt?.isValid) continue;

			const existing = records.get(date);
			// Prefer the LATEST close among multiple exchanges' early-close
			// records — implausibly different times resolve in favor of the
			// later threshold (more conservative override window).
			if (existing?.kind !== "early-close" || closeDt > existing.closeUtc) {
				records.set(date, {
					kind: "early-close",
					closeUtc: closeDt,
					name: name || undefined,
				});
			}
		}
	}

	calendarCache = {
		expiresAt: now + CALENDAR_CACHE_TTL_MS,
		records,
	};
	return records;
}

/**
 * Return whether a UTC instant falls on a US market-closed period.
 *  - `weekend` — Sat/Sun.
 *  - `holiday` — full-day exchange closure.
 *  - `half-day-after-close` — past the early-close on a half-day. Exists so the
 *    local session computation returns "closed" (not "after") in the half-day
 *    "dead zone" between the early close and the regular 4pm boundary, and so
 *    callers don't deliver scheduled notifications during it.
 *  - `null` — ordinary trading instants (including mornings of half-days).
 */
export async function getUsMarketClosureInfoForInstant(
	utcInstant: DateTime,
): Promise<MarketClosureInfo | null> {
	const eastern = utcInstant.setZone(US_MARKET_TIMEZONE);
	if (!eastern.isValid) {
		return null;
	}

	if (eastern.weekday === 6 || eastern.weekday === 7) {
		return { reason: "weekend" };
	}

	const isoDate = eastern.toISODate();
	if (!isoDate) {
		return null;
	}

	const calendar = await fetchUsMarketCalendar();
	const record = calendar.get(isoDate);
	if (!record) return null;

	if (record.kind === "closed") {
		return { reason: "holiday", holidayName: record.name };
	}

	if (utcInstant >= record.closeUtc) {
		return { reason: "half-day-after-close", holidayName: record.name };
	}

	return null;
}
