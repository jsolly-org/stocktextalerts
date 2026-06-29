import { DateTime } from "luxon";
import { getUsMarketClosureInfoForInstant } from "../time/market/calendar";
import type { MarketSession } from "../types";
import { marketDataFetch } from "../vendors/massive";
import { parseMarketSession } from "./session-parse";

export async function getCurrentMarketSession(): Promise<MarketSession> {
	const [data, closure] = await Promise.all([
		marketDataFetch("/v1/marketstatus/now", {}, "market-status"),
		getUsMarketClosureInfoForInstant(DateTime.utc()),
	]);
	// Calendar-aware override: on US half-days, the regular session ends at the
	// early close (typically 1pm ET) and there is NO after-hours session.
	// Massive's `/v1/marketstatus/now` half-day behavior is undocumented; if it
	// flips to `afterHours: true` in the dead zone we'd otherwise classify the
	// session as "after" and fire scheduled notifications with a stale baseline.
	// The calendar tells us this is a half-day-after-close — force "closed".
	if (closure?.reason === "half-day-after-close") {
		return "closed";
	}
	return parseMarketSession(data);
}
