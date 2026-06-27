import { DateTime } from "luxon";
import { rootLogger } from "../logging";
import { getUsMarketClosureInfoForInstant } from "../time/market-calendar";
import { marketDataFetch } from "../vendors/massive/client";
import type { MarketSession } from "./types";

export function parseMarketSession(payload: unknown): MarketSession {
	if (typeof payload !== "object" || payload === null) {
		rootLogger.warn("Massive market-status payload is not an object", { payload });
		return "closed";
	}

	const record = payload as Record<string, unknown>;
	const market = typeof record.market === "string" ? record.market : null;

	if (market === null) {
		rootLogger.warn("Massive market-status payload missing 'market' field", { payload });
		return "closed";
	}

	// Authoritative: market === "open" means regular session, regardless of other flags.
	if (market === "open") return "regular";

	const earlyHours = record.earlyHours === true;
	const afterHours = record.afterHours === true;

	// Corrupt-payload guard: only fires when market !== "open" AND both flags set.
	if (earlyHours && afterHours) {
		rootLogger.warn("Massive market-status returned both earlyHours and afterHours true", {
			payload,
		});
		return "closed";
	}

	if (earlyHours) return "pre";
	if (afterHours) return "after";
	return "closed";
}

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
