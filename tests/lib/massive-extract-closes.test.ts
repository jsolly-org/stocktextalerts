import { describe, expect, it } from "vitest";
import {
	extractClosesAndTimestampsFromBars,
	extractClosesFromBars,
} from "../../src/lib/vendors/massive";

describe("extractClosesFromBars", () => {
	it("returns null for non-object payloads", () => {
		expect(extractClosesFromBars("string")).toBeNull();
		expect(extractClosesFromBars(42)).toBeNull();
		expect(extractClosesFromBars(true)).toBeNull();
		expect(extractClosesFromBars(undefined)).toBeNull();
	});

	it("returns null for null payload", () => {
		expect(extractClosesFromBars(null)).toBeNull();
	});

	it("returns null when results is missing", () => {
		expect(extractClosesFromBars({})).toBeNull();
		expect(extractClosesFromBars({ other: "field" })).toBeNull();
	});

	it("returns null when results is not an array", () => {
		expect(extractClosesFromBars({ results: null })).toBeNull();
		expect(extractClosesFromBars({ results: {} })).toBeNull();
		expect(extractClosesFromBars({ results: "not-array" })).toBeNull();
		expect(extractClosesFromBars({ results: 0 })).toBeNull();
	});

	it("returns null when no valid bars (all entries missing or invalid c)", () => {
		expect(extractClosesFromBars({ results: [] })).toBeNull();
		expect(extractClosesFromBars({ results: [{}] })).toBeNull();
		expect(extractClosesFromBars({ results: [{ o: 1, h: 2, l: 1 }] })).toBeNull();
		expect(extractClosesFromBars({ results: [null] })).toBeNull();
		expect(extractClosesFromBars({ results: ["string"] })).toBeNull();
	});

	it("returns null when all c values are invalid (non-numeric or NaN)", () => {
		expect(extractClosesFromBars({ results: [{ c: "100" }] })).toBeNull();
		expect(extractClosesFromBars({ results: [{ c: NaN }] })).toBeNull();
		expect(extractClosesFromBars({ results: [{ c: Infinity }] })).toBeNull();
		expect(extractClosesFromBars({ results: [{ c: -Infinity }] })).toBeNull();
		expect(extractClosesFromBars({ results: [{ c: null }] })).toBeNull();
	});

	it("extracts c when typeof c === number and Number.isFinite(c)", () => {
		expect(extractClosesFromBars({ results: [{ c: 150.5 }] })).toEqual([150.5]);
		expect(extractClosesFromBars({ results: [{ c: 0 }] })).toEqual([0]);
		expect(extractClosesFromBars({ results: [{ c: -5.5 }] })).toEqual([-5.5]);
	});

	it("ignores bars with non-numeric or NaN c", () => {
		const result = extractClosesFromBars({
			results: [{ c: "skip" }, { c: 100 }, { c: NaN }, { c: 200 }, { c: null }],
		});
		expect(result).toEqual([100, 200]);
	});

	it("returns closes in order for valid bar arrays", () => {
		const result = extractClosesFromBars({
			results: [
				{ o: 1, h: 2, l: 1, c: 1.5 },
				{ o: 1.5, h: 3, l: 1.5, c: 2.5 },
				{ o: 2.5, h: 2.5, l: 2, c: 2.2 },
			],
		});
		expect(result).toEqual([1.5, 2.5, 2.2]);
	});

	it("preserves order with mixed valid and invalid bars", () => {
		const result = extractClosesFromBars({
			results: [{ c: 10 }, { c: "invalid" }, { c: 20 }, { c: NaN }, { c: 30 }],
		});
		expect(result).toEqual([10, 20, 30]);
	});
});

describe("extractClosesAndTimestampsFromBars", () => {
	it("returns null when no valid bars", () => {
		expect(extractClosesAndTimestampsFromBars({ results: [] })).toBeNull();
		expect(extractClosesAndTimestampsFromBars({ results: [{}] })).toBeNull();
	});

	it("extracts closes and timestamps when bars have c and t", () => {
		const t1 = 1737817200000; // 2025-01-25 14:30 UTC (9:30 ET)
		const t2 = 1737820800000; // 2025-01-25 15:40 UTC (10:40 ET)
		const result = extractClosesAndTimestampsFromBars({
			results: [
				{ c: 100, t: t1 },
				{ c: 105, t: t2 },
			],
		});
		expect(result).toEqual({
			closes: [100, 105],
			timestamps: [t1, t2],
			startTimestamp: t1,
			endTimestamp: t2,
			candles: null,
		});
	});

	it("returns null timestamps when bars lack t", () => {
		const result = extractClosesAndTimestampsFromBars({
			results: [{ c: 100 }, { c: 105 }],
		});
		expect(result).toEqual({
			closes: [100, 105],
			timestamps: null,
			startTimestamp: null,
			endTimestamp: null,
			candles: null,
		});
	});

	it("uses first and last valid t for start/end and preserves per-bar timestamps with null for missing", () => {
		const t1 = 1000;
		const t3 = 3000;
		const result = extractClosesAndTimestampsFromBars({
			results: [
				{ c: 10, t: t1 },
				{ c: 20, t: "invalid" },
				{ c: 30, t: t3 },
			],
		});
		expect(result).toEqual({
			closes: [10, 20, 30],
			timestamps: [t1, null, t3],
			startTimestamp: t1,
			endTimestamp: t3,
			candles: null,
		});
	});

	it("extrapolates endTimestamp when trailing bars lack timestamps so time axis aligns with last plotted point", () => {
		const t1 = 1000;
		const t2 = 2000;
		const result = extractClosesAndTimestampsFromBars({
			results: [
				{ c: 10, t: t1 },
				{ c: 20, t: t2 },
				{ c: 30 }, // trailing bar without t
			],
		});
		expect(result).toEqual({
			closes: [10, 20, 30],
			timestamps: [t1, t2, null],
			startTimestamp: t1,
			endTimestamp: 3000, // t2 + 1 * (t2-t1) = 2000 + 1000
			candles: null,
		});
	});
});
