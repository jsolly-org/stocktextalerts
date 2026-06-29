import { getCurrentMarketSession } from "../market-data/session";
import type { MarketSession } from "../types";
import { marketSessionCacheStore } from "./market-session-cache-store";

/**
 * Last successfully resolved market session. Persists across warm Lambda
 * invocations (the schedule cron runs every minute and is warm almost always),
 * so a transient Massive `/v1/marketstatus/now` failure reuses the value from
 * the previous minute instead of aborting the entire run.
 */

/** Max age of a cached session we're willing to reuse during an outage. */
const MAX_STALE_MS = 10 * 60 * 1000;

interface ResolvedMarketSession {
	session: MarketSession;
	/** True when the value came from cache/default because the live call failed. */
	degraded: boolean;
}

/**
 * Resolve the current market session, degrading to the last-known-good value
 * (≤10 min old) or to "closed" when Massive is unreachable. Never throws —
 * a vendor blip must not take down the per-minute scheduler.
 */
export async function resolveMarketSessionWithFallback(
	now: number = Date.now(),
): Promise<ResolvedMarketSession> {
	try {
		const session = await getCurrentMarketSession();
		marketSessionCacheStore.value = { session, atMs: now };
		return { session, degraded: false };
	} catch {
		const cached = marketSessionCacheStore.value;
		if (cached && now - cached.atMs <= MAX_STALE_MS) {
			return { session: cached.session, degraded: true };
		}
		// No fresh cache: "closed" is the safe default — price-history capture is
		// gated on session !== "closed", and scheduled renders degrade to
		// "price unavailable" rather than crashing.
		return { session: "closed", degraded: true };
	}
}
