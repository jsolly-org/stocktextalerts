export type AlertMoveSize = "significant" | "extreme";

interface AlertProfile {
	moveSize: AlertMoveSize;
	percentThreshold: number;
	dollarThreshold: number;
}

export const MOVE_SIZE_THRESHOLDS: Record<
	AlertMoveSize,
	{ percentThreshold: number; dollarThreshold: number }
> = {
	significant: { percentThreshold: 5, dollarThreshold: 10 },
	extreme: { percentThreshold: 8, dollarThreshold: 15 },
};

/** Normalize legacy move-size values to current tiers (moderate→significant, large→extreme). */
export function normalizeMoveSize(
	value: string | null | undefined,
): AlertMoveSize {
	if (value === "significant" || value === "extreme") return value;
	if (value === "moderate") return "significant";
	if (value === "large") return "extreme";
	return "extreme";
}

export function deriveAlertProfile(
	moveSize: AlertMoveSize | string,
): AlertProfile {
	const normalizedMoveSize = normalizeMoveSize(moveSize);
	const threshold = MOVE_SIZE_THRESHOLDS[normalizedMoveSize];
	return {
		moveSize: normalizedMoveSize,
		percentThreshold: threshold.percentThreshold,
		dollarThreshold: threshold.dollarThreshold,
	};
}
