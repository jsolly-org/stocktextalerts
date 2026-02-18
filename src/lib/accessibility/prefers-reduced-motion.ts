/**
 * Utilities for respecting the `prefers-reduced-motion` user preference.
 * Used to disable auto-advancing UI (e.g. retune wizard) when the user requests reduced motion.
 */

/** Media query string for the `prefers-reduced-motion: reduce` user preference. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Returns true when motion-reducing UI (e.g. retune wizard auto-advance) should be disabled.
 * Pass the result of `window.matchMedia(REDUCED_MOTION_QUERY)` or an object with a `matches` property.
 */
export function shouldDisableAutoAdvance(mq: { matches: boolean }): boolean {
	return mq.matches;
}
