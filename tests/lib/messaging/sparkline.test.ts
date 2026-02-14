import { describe, expect, it } from "vitest";
import { toSparkline } from "../../../src/lib/messaging/sparkline";

describe("toSparkline", () => {
	it("converts 7 values to 7 block characters", () => {
		const result = toSparkline([1, 2, 3, 5, 7, 5, 3]);
		expect(result).toHaveLength(7);
	});

	it("returns empty string for fewer than 2 values", () => {
		expect(toSparkline([])).toBe("");
		expect(toSparkline([42])).toBe("");
	});

	it("returns middle blocks when all values are equal", () => {
		const result = toSparkline([5, 5, 5, 5]);
		expect(result).toBe("▄▄▄▄");
	});

	it("maps minimum value to ▁ and maximum to █", () => {
		const result = toSparkline([0, 100]);
		expect(result).toBe("▁█");
	});

	it("maps descending values correctly", () => {
		const result = toSparkline([100, 0]);
		expect(result).toBe("█▁");
	});

	it("handles negative values", () => {
		const result = toSparkline([-10, 0, 10]);
		expect(result[0]).toBe("▁");
		expect(result[2]).toBe("█");
	});

	it("produces distinct characters for a range of values", () => {
		const result = toSparkline([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(result).toBe("▁▂▃▄▅▆▇█");
	});
});
