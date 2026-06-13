/**
 * Per-instance, short-TTL cache of user approval status. Cuts redundant
 * `approved_at` queries on every page load. NOT a failover: see the approval
 * cache note in the HA hardening plan. Cache is per serverless instance.
 */
const TTL_MS = 30_000;

const cache = new Map<string, { approved: boolean; atMs: number }>();

/** Reset cache (tests only). */
export function __resetApprovalCacheForTests(): void {
	cache.clear();
}

/**
 * Return cached approval if fresh, otherwise call `lookup`, cache, and return.
 * Only positive AND negative results are cached for TTL; this means a freshly
 * approved user may wait up to TTL_MS — acceptable for a 30s window.
 */
export async function getApprovalCached(
	userId: string,
	lookup: () => Promise<boolean>,
	now: number = Date.now(),
	ttlMs: number = TTL_MS,
): Promise<boolean> {
	const hit = cache.get(userId);
	if (hit && now - hit.atMs <= ttlMs) {
		return hit.approved;
	}
	const approved = await lookup();
	cache.set(userId, { approved, atMs: now });
	return approved;
}
