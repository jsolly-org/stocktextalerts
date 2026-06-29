import { rootLogger } from "../logging";
import type { MarketSession } from "../market-data-types";

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
