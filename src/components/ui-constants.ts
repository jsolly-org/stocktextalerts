/** UI tone variants used by status/flash messaging components. */
export type StatusTone = "success" | "error" | "warning" | "info";

/** Allowed flash-message tones (subset of `StatusTone`). */
export type FlashTone = Extract<StatusTone, "success" | "error" | "warning">;
/** Flash message payload used by UI components. */
export type FlashMessage = { tone: FlashTone; message: string };

/** CSS class names for each `StatusTone`. */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
	success: "status-tone-success",
	error: "status-tone-error",
	warning: "status-tone-warning",
	info: "status-tone-info",
};
