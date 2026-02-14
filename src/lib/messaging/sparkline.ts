const BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * Convert an array of numeric values into a Unicode block-character sparkline.
 *
 * Returns empty string if fewer than 2 values.
 * Returns middle blocks (`▄`) when all values are equal.
 */
export function toSparkline(values: number[]): string {
	if (values.length < 2) return "";

	const min = Math.min(...values);
	const max = Math.max(...values);

	if (min === max) {
		return BLOCKS[3].repeat(values.length);
	}

	const range = max - min;
	return values
		.map((v) => {
			const index = Math.round(((v - min) / range) * (BLOCKS.length - 1));
			return BLOCKS[index];
		})
		.join("");
}

export type SparklineMap = Map<string, string | null>;
