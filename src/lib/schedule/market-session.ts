import { getCurrentMarketSession, type MarketSession } from "../vendors/price-fetcher";

/**
 * Last successfully resolved market session. Persists across warm Lambda
 * invocations (the schedule cron runs every minute and is warm almost always),
 * so a transient Massive `/v1/marketstatus/now` failure reuses the value from
 * the previous minute instead of aborting the entire run.
 */
let cached: { session: MarketSession; atMs: number } | null = null;

/** Max age of a cached session we're willing to reuse during an outage. */
const MAX_STALE_MS = 10 * 60 * 1000;

interface ResolvedMarketSession {
	session: MarketSession;
	/** True when the value came from cache/default because the live call failed. */
	degraded: boolean;
}

/** Reset module cache (tests only). */
export function __resetMarketSessionCacheForTests(): void {
	cached = null;
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
		cached = { session, atMs: now };
		return { session, degraded: false };
	} catch {
		if (cached && now - cached.atMs <= MAX_STALE_MS) {
			return { session: cached.session, degraded: true };
		}
		// No fresh cache: "closed" is the safe default — price-history capture is
		// gated on session !== "closed", and scheduled renders degrade to
		// "price unavailable" rather than crashing.
		return { session: "closed", degraded: true };
	}
}
