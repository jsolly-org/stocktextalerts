/**
 * Utilities for respecting the `prefers-reduced-motion` user preference.
 * Used to disable auto-advancing UI (e.g. retune wizard) when the user requests reduced motion.
 */

/** Media query string for the `prefers-reduced-motion: reduce` user preference. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
