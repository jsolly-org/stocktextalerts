/**
 * Utilities for respecting the `prefers-reduced-motion` user preference.
 * Used to disable auto-advancing UI (e.g. retune wizard) when the user requests reduced motion.
 */

import { onMounted, onUnmounted, ref } from "vue";

/** Media query string for the `prefers-reduced-motion: reduce` user preference. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Composable that returns a reactive ref tracking the user's prefers-reduced-motion preference.
 * Sets up and tears down the media query listener automatically.
 */
export function usePrefersReducedMotion() {
	const prefersReducedMotion = ref(false);
	let motionQuery: MediaQueryList | null = null;

	function handleMotionChange(event: MediaQueryListEvent) {
		prefersReducedMotion.value = event.matches;
	}

	onMounted(() => {
		motionQuery = window.matchMedia(REDUCED_MOTION_QUERY);
		prefersReducedMotion.value = motionQuery.matches;
		motionQuery.addEventListener("change", handleMotionChange);
	});

	onUnmounted(() => {
		motionQuery?.removeEventListener("change", handleMotionChange);
	});

	return prefersReducedMotion;
}
