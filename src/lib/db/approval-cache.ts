/**
 * Per-instance cache of user approval status. Cuts redundant `approved_at`
 * queries on every page load. NOT a failover: see the approval cache note in
 * the HA hardening plan. Cache is per serverless instance.
 *
 * Approved users are cached without expiry (approval is one-way in this app).
 * Unapproved users use a short TTL so a fresh admin approval is picked up quickly.
 */
const UNAPPROVED_TTL_MS = 30_000;

const cache = new Map<string, { approved: boolean; atMs: number }>();

/** Reset cache (tests only). */
export function __resetApprovalCacheForTests(): void {
	cache.clear();
}

function isCacheHit(hit: { approved: boolean; atMs: number }, now: number, ttlMs: number): boolean {
	if (hit.approved) {
		return true;
	}
	return now - hit.atMs <= ttlMs;
}

/**
 * Return cached approval if fresh, otherwise call `lookup`, cache, and return.
 * Approved results stick for the life of the instance; unapproved results
 * expire after UNAPPROVED_TTL_MS so newly approved users are not blocked long.
 */
export async function getApprovalCached(
	userId: string,
	lookup: () => Promise<boolean>,
	now: number = Date.now(),
	unapprovedTtlMs: number = UNAPPROVED_TTL_MS,
): Promise<boolean> {
	const hit = cache.get(userId);
	if (hit && isCacheHit(hit, now, unapprovedTtlMs)) {
		return hit.approved;
	}
	const approved = await lookup();
	cache.set(userId, { approved, atMs: now });
	return approved;
}
