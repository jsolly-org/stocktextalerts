export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Returns true when motion-reducing UI (e.g. retune wizard auto-advance) should be disabled. */
export function shouldDisableAutoAdvance(mq: { matches: boolean }): boolean {
	return mq.matches;
}
