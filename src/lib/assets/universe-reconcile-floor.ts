/**
 * Absolute floor on the fetched active-set size below which step 3 skips delist-flagging as a
 * suspected silent truncation. The real US stock+ETF active universe is ~11k; a truncated fetch
 * degrades to one or a few 1000-row pages. Deliberately an ABSOLUTE floor, NOT a fraction of the
 * stored active count — that count is inflated by the very backlog this job exists to drain.
 */
export const MIN_PLAUSIBLE_ACTIVE_UNIVERSE = 5000;

/** True when the fetched active set is below the plausibility floor. */
export function activeSetTooSmallToFlag(activeCount: number): boolean {
	return activeCount < MIN_PLAUSIBLE_ACTIVE_UNIVERSE;
}
