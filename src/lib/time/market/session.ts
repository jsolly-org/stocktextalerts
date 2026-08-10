import {
	US_EQUITY_TRADE_CLOSE_EASTERN_MINUTES,
	US_EQUITY_TRADE_OPEN_EASTERN_MINUTES,
	US_MARKET_CLOSE_EASTERN_MINUTES,
	US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_OPEN_EASTERN_MINUTES,
} from "../../constants";
import type { ActiveMarketSession, MarketSession } from "../../types";

/**
 * True when the given ET-minute is outside the allowed market notification
 * window (4:30 AM – 7:30 PM ET, i.e. [270, 1170]).
 *
 * Operates on ET-minutes directly — callers convert from user-local at the
 * boundary via `userLocalToEtMinute` if needed.
 */
export function isOutsideMarketHours(etMinutes: number): boolean {
	if (!Number.isInteger(etMinutes) || etMinutes < 0 || etMinutes > 1439) {
		return true;
	}
	return (
		etMinutes < US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES ||
		etMinutes > US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES
	);
}

/**
 * True when outside the Massive-capped equity trade window [04:00, 20:00) ET.
 * Used for stock-buyer lambda quote/alert coverage; human notifications stay on
 * {@link isOutsideMarketHours}.
 */
export function isOutsideEquityTradeHours(etMinutes: number): boolean {
	if (!Number.isInteger(etMinutes) || etMinutes < 0 || etMinutes > 1439) {
		return true;
	}
	return (
		etMinutes < US_EQUITY_TRADE_OPEN_EASTERN_MINUTES ||
		etMinutes >= US_EQUITY_TRADE_CLOSE_EASTERN_MINUTES
	);
}

/**
 * Classify an ET-minute against the regular session boundaries
 * (9:30 AM and 4:00 PM ET). Used to label scheduled-time chips with a
 * session badge.
 *
 * Boundary semantics: 9:30 AM ET (570) is "regular"; 4:00 PM ET (960)
 * is "after". Any minute below 570 returns "pre", including out-of-window
 * times (< 270) — callers either gate on `isOutsideMarketHours` first or
 * ignore the result for invalid inputs.
 */
export function getScheduledMarketSession(etMinutes: number): ActiveMarketSession {
	if (etMinutes < US_MARKET_OPEN_EASTERN_MINUTES) return "pre";
	if (etMinutes >= US_MARKET_CLOSE_EASTERN_MINUTES) return "after";
	return "regular";
}

/**
 * Equity trade session for stock-buyer: closed outside [04:00, 20:00) ET,
 * otherwise the same pre/regular/after labels as {@link getScheduledMarketSession}.
 */
export function getEquityTradeSession(etMinutes: number): MarketSession {
	if (isOutsideEquityTradeHours(etMinutes)) return "closed";
	return getScheduledMarketSession(etMinutes);
}
