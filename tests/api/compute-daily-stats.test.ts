import { describe, expect, it } from "vitest";
import {
	computeADV,
	computeATR,
} from "../../src/lib/market-notifications/daily-stats";
import { extractOHLCVFromBars } from "../../src/lib/providers/massive";

describe("compute-daily-stats integration", () => {
	it("extractOHLCVFromBars extracts full OHLCV bars correctly", () => {
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

	it("extractOHLCVFromBars returns null for invalid payloads", () => {
		expect(extractOHLCVFromBars(null)).toBeNull();
		expect(extractOHLCVFromBars("not an object")).toBeNull();
		expect(extractOHLCVFromBars({ results: [] })).toBeNull();
		expect(
			extractOHLCVFromBars({
				results: [{ o: "bad", h: 1, l: 1, c: 1, v: 1 }],
			}),
		).toBeNull();
	});

	it("extractOHLCVFromBars skips bars with missing fields", () => {
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

	it("end-to-end: extract bars → compute ADV + ATR", () => {
		const payload = {
			results: Array.from({ length: 25 }, (_, i) => ({
				o: 100 + i * 0.5,
				h: 105 + i * 0.5,
				l: 95 + i * 0.5,
				c: 102 + i * 0.5,
				v: 1_000_000 + i * 50_000,
				t: 1700000000000 + i * 86400000,
			})),
		};

		const bars = extractOHLCVFromBars(payload);
		expect(bars).not.toBeNull();
		if (!bars) return;

		const adv = computeADV(bars);
		expect(adv).not.toBeNull();
		expect(adv).toBeGreaterThan(0);

		const atr = computeATR(bars);
		expect(atr).not.toBeNull();
		expect(atr).toBeGreaterThan(0);
	});
});
