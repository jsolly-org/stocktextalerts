export type AlertMoveSize = "significant" | "extreme";

/** Anomaly-score thresholds per move-size tier.
 *  Lower = more sensitive (fires on smaller anomalies).
 *  Max total score is 100 (45 price + 15 breakout + 25 news + 15 earnings). */
export const ANOMALY_THRESHOLDS: Record<AlertMoveSize, number> = {
	significant: 45,
	extreme: 60,
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

export function getAnomalyThreshold(moveSize: AlertMoveSize | string): number {
	const normalized = normalizeMoveSize(moveSize);
	return ANOMALY_THRESHOLDS[normalized];
}
