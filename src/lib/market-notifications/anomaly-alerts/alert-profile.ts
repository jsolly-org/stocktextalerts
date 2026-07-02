import type { AlertMoveSize } from "../../db";

/** Anomaly-score thresholds per move-size tier.
 *  Lower = more sensitive (fires on smaller anomalies).
 *  Max total score is 100 (50 price + 20 volume + 15 breakout + 15 earnings). */
const ANOMALY_THRESHOLDS: Record<AlertMoveSize, number> = {
	significant: 45,
	extreme: 60,
};

export function getAnomalyThreshold(moveSize: AlertMoveSize): number {
	return ANOMALY_THRESHOLDS[moveSize];
}
