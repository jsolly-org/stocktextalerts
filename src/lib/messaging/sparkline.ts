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

/** Numeric values plus the precomputed Unicode block-character sparkline string. */
export interface SparklineData {
	values: number[];
	ascii: string;
}

/** Map of symbol to sparkline data (values + ASCII) or null when unavailable. */
export type SparklineMap = Map<string, SparklineData | null>;
