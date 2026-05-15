import { afterEach, describe, expect, it, vi } from "vitest";
import { extractOHLCVFromBars, fetchPrevDayBar } from "../../../src/lib/providers/massive";

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

describe("Daily digest fallback for an illiquid ticker missing from the live snapshot", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces Massive's prev-day `t` (milliseconds) as Unix seconds so the digest banner renders the actual close", async () => {
		// Wed May 13, 2026 16:00 ET = 20:00 UTC. Polygon-style daily-bar `t`
		// is milliseconds; the digest's `formatQuoteTimestamp` multiplies by
		// 1000 to convert seconds→ms before `new Date(...)`. Returning ms
		// raw (the pre-fix bug) pushes the banner's "as of" date to year
		// ~58000 — fetchPrevDayBar must normalize to seconds at the source.
		const closeMs = Date.UTC(2026, 4, 13, 20, 0);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [{ o: 175.0, h: 178.5, l: 174.2, c: 177.3, v: 12_345_678, t: closeMs }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const bar = await fetchPrevDayBar("AAPL");

		expect(bar).not.toBeNull();
		expect(bar?.timestamp).toBe(Math.floor(closeMs / 1000));
	});
});
