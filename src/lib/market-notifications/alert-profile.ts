export type AlertRiskPriority = "both_equally";
export type AlertMarketContext = "standout" | "any_major";
export type AlertMoveSize = "significant" | "extreme";
export type AlertFollowUpMode = "first_only" | "allow_follow_up";
type AlertDirectionPreference = "downside" | "upside" | "both";

interface AlertProfile {
	riskPriority: AlertRiskPriority;
	marketContext: AlertMarketContext;
	moveSize: AlertMoveSize;
	followUpMode: AlertFollowUpMode;
	directionPreference: AlertDirectionPreference;
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

function toDirectionPreference(
	_riskPriority: AlertRiskPriority,
): AlertDirectionPreference {
	return "both";
}

export function deriveAlertProfile(options: {
	riskPriority: AlertRiskPriority;
	marketContext: AlertMarketContext;
	moveSize: AlertMoveSize | string;
	followUpMode?: AlertFollowUpMode;
}): AlertProfile {
	const {
		riskPriority,
		marketContext,
		moveSize,
		followUpMode = "first_only",
	} = options;
	const normalizedMoveSize = normalizeMoveSize(moveSize);
	const threshold = MOVE_SIZE_THRESHOLDS[normalizedMoveSize];
	return {
		riskPriority,
		marketContext,
		moveSize: normalizedMoveSize,
		followUpMode,
		directionPreference: toDirectionPreference(riskPriority),
		percentThreshold: threshold.percentThreshold,
		dollarThreshold: threshold.dollarThreshold,
	};
}
