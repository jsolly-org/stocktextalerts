import {
	US_MARKET_CLOSE_EASTERN_MINUTES,
	US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_OPEN_EASTERN_MINUTES,
} from "../../constants";
import type { ActiveMarketSession } from "../../types";

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
