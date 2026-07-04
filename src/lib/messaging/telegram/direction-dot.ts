const UP = "🟢";
const DOWN = "🔴";
const FLAT = "⚪️";

export function directionDot(changePercent: number): string {
	return changePercent > 0 ? UP : changePercent < 0 ? DOWN : FLAT;
}
