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

function toDirectionPreference(
	_riskPriority: AlertRiskPriority,
): AlertDirectionPreference {
	return "both";
}

export function deriveAlertProfile(options: {
	riskPriority: AlertRiskPriority;
	marketContext: AlertMarketContext;
	moveSize: AlertMoveSize;
	followUpMode?: AlertFollowUpMode;
}): AlertProfile {
	const {
		riskPriority,
		marketContext,
		moveSize,
		followUpMode = "first_only",
	} = options;
	const threshold =
		MOVE_SIZE_THRESHOLDS[moveSize] ?? MOVE_SIZE_THRESHOLDS.extreme;
	return {
		riskPriority,
		marketContext,
		moveSize,
		followUpMode,
		directionPreference: toDirectionPreference(riskPriority),
		percentThreshold: threshold.percentThreshold,
		dollarThreshold: threshold.dollarThreshold,
	};
}
