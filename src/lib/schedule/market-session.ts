import { getCurrentEquityTradeSession, getCurrentMarketSession } from "../market-data/session";
import type { MarketSession } from "../types";
import { marketSessionCacheStore } from "./market-session-cache-store";

/**
 * Last successfully resolved market sessions. Persists across warm Lambda
 * invocations (the schedule cron runs every minute and is warm almost always),
 * so a transient calendar blip reuses the value from the previous minute instead
 * of aborting the entire run.
 */

/** Max age of a cached session we're willing to reuse during an outage. */
const MAX_STALE_MS = 10 * 60 * 1000;

interface ResolvedMarketSessions {
	/** Human notification window (04:30–19:30 ET). */
	humanSession: MarketSession;
	/** Massive-capped equity window for stock-buyer (04:00–20:00 ET). */
	equitySession: MarketSession;
	/** True when the value came from cache/default because the live call failed. */
	degraded: boolean;
}

/**
 * Resolve human + equity market sessions, degrading to the last-known-good pair
 * (≤10 min old) or to "closed"/"closed" when the calendar is unreachable. Never throws —
 * a vendor blip must not take down the per-minute scheduler.
 */
export async function resolveMarketSessionWithFallback(
	now: number = Date.now(),
): Promise<ResolvedMarketSessions> {
	try {
		const [humanSession, equitySession] = await Promise.all([
			getCurrentMarketSession(),
			getCurrentEquityTradeSession(),
		]);
		marketSessionCacheStore.value = { humanSession, equitySession, atMs: now };
		return { humanSession, equitySession, degraded: false };
	} catch {
		const cached = marketSessionCacheStore.value;
		if (cached && now - cached.atMs <= MAX_STALE_MS) {
			return {
				humanSession: cached.humanSession,
				equitySession: cached.equitySession,
				degraded: true,
			};
		}
		// No fresh cache: "closed" is the safe default — price-history capture is
		// gated on equity session !== "closed", and scheduled renders degrade to
		// "price unavailable" rather than crashing.
		return { humanSession: "closed", equitySession: "closed", degraded: true };
	}
}
