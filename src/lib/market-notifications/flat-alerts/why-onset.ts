import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../../constants";
import { getUsMarketClosureInfoForInstant } from "../../time/market/calendar";
import type { MarketClosureInfo } from "../../time/types";
import type { IntradayBarsResult } from "../../types";

/** Enough to clear a weekend plus the longest US market holiday cluster. */
const MAX_SESSION_LOOKBACK_DAYS = 7;

type ClosureLookup = (instant: DateTime) => Promise<MarketClosureInfo | null>;

/**
 * Inclusive calendar dates for `x_search` covering the previous *session* through now (ET).
 * Walks the US market calendar, so a Tuesday after a Monday holiday reaches back to Friday.
 */
export async function moveWindowXSearchDates(
	now: DateTime = DateTime.now(),
	closureLookup: ClosureLookup = getUsMarketClosureInfoForInstant,
): Promise<{ from_date: string; to_date: string }> {
	const et = now.setZone(US_MARKET_TIMEZONE);
	const toDate = et.toISODate();

	let from = et.minus({ days: 1 });
	for (let i = 0; i < MAX_SESSION_LOOKBACK_DAYS; i++) {
		// Probe midday so a half-day's post-close window never reads as a closure.
		const closure = await closureLookup(from.set({ hour: 12, minute: 0 }).toUTC());
		if (closure?.reason !== "weekend" && closure?.reason !== "holiday") break;
		from = from.minus({ days: 1 });
	}

	const fromDate = from.toISODate();
	if (!fromDate || !toDate) {
		throw new Error("Failed to format move-window x_search dates");
	}
	return { from_date: fromDate, to_date: toDate };
}

function formatEtTime(ms: number): string {
	return `${DateTime.fromMillis(ms, { zone: US_MARKET_TIMEZONE }).toFormat("HH:mm")} ET`;
}

/**
 * First bar where the session move is at least half complete.
 * Returns null when bars have no usable timestamps.
 */
export function deriveMoveOnsetEt(intraday: IntradayBarsResult): string | null {
	const candles = intraday.candles;
	if (candles && candles.length > 0) {
		const first = candles[0];
		const last = candles[candles.length - 1];
		if (!first || !last) return null;
		const total = last.c - first.c;
		const threshold = Math.abs(total) * 0.5;
		if (threshold === 0) {
			return formatEtTime(first.t);
		}
		for (const candle of candles) {
			if (Math.abs(candle.c - first.c) >= threshold) {
				return formatEtTime(candle.t);
			}
		}
		return formatEtTime(last.t);
	}

	const stamps = intraday.timestamps;
	const closes = intraday.closes;
	if (!stamps || stamps.length === 0 || closes.length === 0) {
		if (intraday.startTimestamp !== null) {
			return formatEtTime(intraday.startTimestamp);
		}
		return null;
	}

	const firstClose = closes[0];
	const lastClose = closes[closes.length - 1];
	if (firstClose === undefined || lastClose === undefined) return null;
	const total = lastClose - firstClose;
	const threshold = Math.abs(total) * 0.5;
	for (let i = 0; i < closes.length; i++) {
		const close = closes[i];
		const stamp = stamps[i];
		if (close === undefined || stamp === null || stamp === undefined) continue;
		if (threshold === 0 || Math.abs(close - firstClose) >= threshold) {
			return formatEtTime(stamp);
		}
	}
	return null;
}
