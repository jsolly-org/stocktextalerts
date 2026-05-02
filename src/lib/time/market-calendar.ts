import type { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
import { marketDataFetch } from "../providers/massive";

export type MarketClosureReason = "weekend" | "holiday";

export interface MarketClosureInfo {
	reason: MarketClosureReason;
	/** Holiday name from the exchange calendar (e.g. "Presidents' Day"), if available. */
	holidayName?: string;
}

const HOLIDAY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let holidayCache: {
	expiresAt: number;
	holidays: Map<string, string | undefined>;
} | null = null;

/** Fetch and cache upcoming full-day US market closures (NYSE/NASDAQ). */
async function fetchUsMarketHolidays(): Promise<Map<string, string | undefined>> {
	const now = Date.now();
	if (holidayCache && holidayCache.expiresAt > now) {
		return holidayCache.holidays;
	}

	const payload = await marketDataFetch("/v1/marketstatus/upcoming", {}, "market-holidays");

	const holidays = new Map<string, string | undefined>();
	if (!Array.isArray(payload)) return holidays;

	for (const row of payload) {
		if (typeof row !== "object" || row === null) continue;
		const record = row as Record<string, unknown>;

		const exchange = typeof record.exchange === "string" ? record.exchange : "";
		const status = typeof record.status === "string" ? record.status : "";
		const date = typeof record.date === "string" ? record.date : "";
		const name = typeof record.name === "string" ? record.name.trim() : "";

		// Only include NYSE/NASDAQ full closures
		if (
			!(exchange.includes("NYSE") || exchange.includes("NASDAQ")) ||
			status !== "closed" ||
			!/^\d{4}-\d{2}-\d{2}$/.test(date)
		) {
			continue;
		}

		holidays.set(date, name || undefined);
	}

	holidayCache = {
		expiresAt: now + HOLIDAY_CACHE_TTL_MS,
		holidays,
	};
	return holidays;
}

/**
 * Return whether a UTC instant falls on a US market-closed date (full-day closure only).
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

	const holidays = await fetchUsMarketHolidays();
	if (holidays.has(isoDate)) {
		return { reason: "holiday", holidayName: holidays.get(isoDate) };
	}
	return null;
}
