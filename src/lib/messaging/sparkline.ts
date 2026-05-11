const BLOCKS = "▁▂▃▄▅▆▇█";
const MID_BLOCK = "▄";
const LOW_BLOCK = "▁";

/**
 * Convert an array of numeric values into a Unicode block-character sparkline.
 *
 * Returns empty string if fewer than 2 values.
 * Returns middle blocks (`▄`) when all values are equal.
 */
export function toSparkline(values: number[]): string {
	if (values.length < 2) return "";

	const finiteValues = values.filter((v) => Number.isFinite(v));
	if (finiteValues.length === 0) return "";

	const min = Math.min(...finiteValues);
	const max = Math.max(...finiteValues);

	if (min === max) {
		// Preserve the "all values equal" fast path for fully-finite inputs.
		if (finiteValues.length === values.length) {
			return MID_BLOCK.repeat(values.length);
		}

		// If any values are non-finite, treat them as the lowest value.
		return values.map((v) => (Number.isFinite(v) ? MID_BLOCK : LOW_BLOCK)).join("");
	}

	const range = max - min;
	return values
		.map((v) => {
			const normalized = Number.isFinite(v) ? (v - min) / range : 0;
			const rawIndex = normalized * (BLOCKS.length - 1);
			const index = Math.max(0, Math.min(BLOCKS.length - 1, Math.floor(rawIndex)));
			return BLOCKS.charAt(index);
		})
		.join("");
}

/**
 * Which price window a sparkline represents. The label rendered next to the
 * sparkline (in SMS and email) is derived from this discriminator.
 */
export type SparklineWindow = "intraday-since-open" | "7-trading-days";

/**
 * Max sparkline chars for SMS. Unicode blocks force UCS-2 (70 chars/segment);
 * 12 fits comfortably with the surrounding price line. Used as the downsample
 * target for any series longer than this (e.g., intraday 5-min bars ~78/day).
 */
const SMS_SPARKLINE_LENGTH = 12;

/**
 * Downsample to at most `maxLength` evenly spaced points, preserving endpoints.
 * Returns the input unchanged when it already fits, or when `maxLength < 2`.
 */
export function downsampleEvenly(values: number[], maxLength = SMS_SPARKLINE_LENGTH): number[] {
	if (maxLength < 2 || values.length <= maxLength) return values;
	const out: number[] = [];
	for (let i = 0; i < maxLength; i++) {
		const idx = Math.round((i / (maxLength - 1)) * (values.length - 1));
		const v = values[idx];
		if (v !== undefined) out.push(v);
	}
	return out;
}

/** Numeric values plus the precomputed Unicode block-character sparkline string. */
export interface SparklineData {
	values: number[];
	ascii: string;
	window: SparklineWindow;
}

/** Map of symbol to sparkline data (values + ASCII + window) or null when unavailable. */
export type SparklineMap = Map<string, SparklineData | null>;

/** Terse per-line label rendered before a sparkline in SMS. UCS-2 keeps these short. */
export const SMS_SPARKLINE_LABEL: Record<SparklineWindow, string> = {
	"intraday-since-open": "today",
	"7-trading-days": "7d",
};

/** Verbose label rendered inline before a sparkline in email HTML. */
export const EMAIL_SPARKLINE_LABEL: Record<SparklineWindow, string> = {
	"intraday-since-open": "Today since open",
	"7-trading-days": "Past 7 trading days",
};
