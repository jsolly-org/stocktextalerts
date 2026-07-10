import { DateTime } from "luxon";
import { US_MARKET_TIMEZONE } from "../constants";
import { getUsMarketClosureInfoForInstant } from "../time/market/calendar";
import { getScheduledMarketSession, isOutsideMarketHours } from "../time/market/session";
import { minuteOfDayFromDateTime } from "../time/utils";
import type { MarketSession } from "../types";

/**
 * Determine the current US market session locally — no live vendor call.
 *
 * Weekend / full holiday / past a half-day's early close come from the 12h-cached holiday
 * calendar (`getUsMarketClosureInfoForInstant`); the pre/regular/after split is a pure
 * ET-clock classification against the market-notification window (4:30 AM–7:30 PM ET).
 *
 * This replaced a per-scheduler-tick Massive `/v1/marketstatus/now` call: the only remaining
 * vendor dependency is the holiday calendar's 12h-cached `/v1/marketstatus/upcoming` fetch
 * (~2 calls/day). A half-day after its early close reports `half-day-after-close` from the
 * calendar → "closed", matching the prior override behavior.
 */
export async function getCurrentMarketSession(): Promise<MarketSession> {
	const now = DateTime.utc();
	// Weekend, full holiday, or past a half-day's early close → no trading session.
	if ((await getUsMarketClosureInfoForInstant(now)) !== null) {
		return "closed";
	}
	const etMinutes = minuteOfDayFromDateTime(now.setZone(US_MARKET_TIMEZONE));
	if (isOutsideMarketHours(etMinutes)) {
		return "closed";
	}
	return getScheduledMarketSession(etMinutes);
}
