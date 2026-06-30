import { MIN_PLAUSIBLE_ACTIVE_UNIVERSE } from "./constants";

/** True when the fetched active set is below the plausibility floor. */
export function activeSetTooSmallToFlag(activeCount: number): boolean {
	return activeCount < MIN_PLAUSIBLE_ACTIVE_UNIVERSE;
}
