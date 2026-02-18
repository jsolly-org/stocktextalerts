import { describe, expect, it } from "vitest";
import { extractClosesFromBars } from "../../src/lib/providers/massive";

describe("extractClosesFromBars", () => {
	it("returns null for non-object payload", () => {
		expect(extractClosesFromBars("string")).toBeNull();
		expect(extractClosesFromBars(42)).toBeNull();
		expect(extractClosesFromBars(true)).toBeNull();
	});

	it("returns null for null payload", () => {
		expect(extractClosesFromBars(null)).toBeNull();
	});

	it("returns null when results is missing", () => {
		expect(extractClosesFromBars({})).toBeNull();
	});

	it("returns null when results is not an array", () => {
		expect(extractClosesFromBars({ results: null })).toBeNull();
		expect(extractClosesFromBars({ results: {} })).toBeNull();
		expect(extractClosesFromBars({ results: "not-array" })).toBeNull();
	});

	it("returns null when no valid bars (all entries missing or invalid c)", () => {
		expect(extractClosesFromBars({ results: [] })).toBeNull();
		expect(extractClosesFromBars({ results: [{}] })).toBeNull();
		expect(
			extractClosesFromBars({ results: [{ o: 1, h: 2, l: 1 }] }),
		).toBeNull();
		expect(extractClosesFromBars({ results: [{ c: "150" }] })).toBeNull();
		expect(extractClosesFromBars({ results: [{ c: NaN }] })).toBeNull();
		expect(extractClosesFromBars({ results: [{ c: Infinity }] })).toBeNull();
		expect(extractClosesFromBars({ results: [null, undefined] })).toBeNull();
	});

	it("extracts c when typeof c === 'number' && Number.isFinite(c)", () => {
		expect(
			extractClosesFromBars({
				results: [{ c: 150.5 }, { c: 151.25 }],
			}),
		).toEqual([150.5, 151.25]);
	});

	it("ignores bars with non-numeric or NaN c", () => {
		expect(
			extractClosesFromBars({
				results: [
					{ c: "skip" },
					{ c: 100 },
					{ c: NaN },
					{ c: 200 },
					{},
					{ c: Infinity },
				],
			}),
		).toEqual([100, 200]);
	});

	it("returns closes in order for valid bar arrays", () => {
		const payload = {
			results: [
				{ c: 188 },
				{ c: 190 },
				{ c: 191 },
				{ c: 193 },
				{ c: 196 },
				{ c: 194 },
				{ c: 195 },
			],
		};
		expect(extractClosesFromBars(payload)).toEqual([
			188, 190, 191, 193, 196, 194, 195,
		]);
	});
});
