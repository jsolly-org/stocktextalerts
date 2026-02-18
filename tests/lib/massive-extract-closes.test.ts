import { describe, expect, it } from "vitest";
import { extractClosesFromBars } from "../../src/lib/providers/massive";

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
		expect(
			extractClosesFromBars({ results: [{ o: 1, h: 2, l: 1 }] }),
		).toBeNull();
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
