import { describe, expect, it } from "vitest";
import { extractOHLCVFromBars } from "../../../src/lib/providers/massive";

describe("Massive OHLCV bar extraction", () => {
	it("extracts full OHLCV bars from a valid aggregates response", () => {
		const payload = {
			results: [
				{ o: 100, h: 105, l: 95, c: 102, v: 1_000_000, t: 1700000000000 },
				{ o: 103, h: 108, l: 100, c: 106, v: 1_200_000, t: 1700086400000 },
			],
		};

		const bars = extractOHLCVFromBars(payload);
		expect(bars).not.toBeNull();
		expect(bars).toHaveLength(2);
		expect(bars?.[0]).toEqual({
			open: 100,
			high: 105,
			low: 95,
			close: 102,
			volume: 1_000_000,
		});
	});

	it("returns null for invalid or empty payloads", () => {
		expect(extractOHLCVFromBars(null)).toBeNull();
		expect(extractOHLCVFromBars("not an object")).toBeNull();
		expect(extractOHLCVFromBars({ results: [] })).toBeNull();
		expect(
			extractOHLCVFromBars({
				results: [{ o: "bad", h: 1, l: 1, c: 1, v: 1 }],
			}),
		).toBeNull();
	});

	it("skips bars with missing or invalid fields and returns the rest", () => {
		const payload = {
			results: [
				{ o: 100, h: 105, l: 95, c: 102, v: 1_000_000 },
				{ o: 103, h: null, l: 100, c: 106, v: 1_200_000 },
				{ o: 104, h: 109, l: 101, c: 107, v: 900_000 },
			],
		};

		const bars = extractOHLCVFromBars(payload);
		expect(bars).toHaveLength(2);
	});
});
