import type { StatusTone } from "./types";

/** CSS class names for each `StatusTone`. */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
	success: "status-tone-success",
	error: "status-tone-error",
	warning: "status-tone-warning",
	info: "status-tone-info",
};
