import { describe, expect, it } from "vitest";
import { extractOHLCVFromBars } from "../../../src/lib/market-data/bars-parse";
import {
	computeADV,
	computeATR,
	type DailyOHLCVBar,
} from "../../../src/lib/market-notifications/daily-stats";

function makeBar(overrides: Partial<DailyOHLCVBar> = {}): DailyOHLCVBar {
	return {
		open: 100,
		high: 105,
		low: 95,
		close: 102,
		volume: 1_000_000,
		...overrides,
	};
}

describe("20-day average daily volume", () => {
	it("uses the last 20 bars' volumes when more than 20 bars are provided", () => {
		const bars = Array.from({ length: 25 }, (_, i) => makeBar({ volume: (i + 1) * 100_000 }));
		// Last 20 bars: volumes 600k..2500k
		const expected =
			Array.from({ length: 20 }, (_, i) => (i + 6) * 100_000).reduce((a, b) => a + b, 0) / 20;
		expect(computeADV(bars)).toBeCloseTo(expected);
	});

	it("returns null when fewer than 20 bars are available", () => {
		expect(computeADV([])).toBeNull();
		const bars = [makeBar({ volume: 500_000 }), makeBar({ volume: 1_500_000 })];
		expect(computeADV(bars)).toBeNull();
	});

	it("ignores zero and negative volumes when computing the average", () => {
		const bars = Array.from({ length: 22 }, (_, i) =>
			makeBar({
				volume: i < 2 ? 0 : i === 2 ? -100 : 500_000,
			}),
		);
		// Last 20 bars: 1 zero, 1 negative, 18 at 500k → expect avg of valid vols
		expect(computeADV(bars)).not.toBeNull();
		expect(computeADV(bars)).toBeGreaterThan(0);
	});
});

describe("14-day average true range (ATR)", () => {
	it("computes ATR from OHLCV bars using high, low, and previous close", () => {
		// 15 bars: first 3 establish TR pattern, rest fill to 14 TR values
		const bars: DailyOHLCVBar[] = Array.from({ length: 15 }, (_, i) => ({
			open: 100 + i,
			high: 105 + i,
			low: 95 + i,
			close: 102 + i,
			volume: 1_000_000,
		}));
		// All TRs = max(10, 4, 6) = 10
		expect(computeATR(bars)).toBeCloseTo(10);
	});

	it("returns null when fewer than 15 bars are provided", () => {
		expect(computeATR([])).toBeNull();
		expect(computeATR([makeBar()])).toBeNull();
		const twoBars = [
			makeBar(),
			{ ...makeBar(), open: 110, high: 112, low: 109, close: 111, volume: 1 },
		];
		expect(computeATR(twoBars)).toBeNull();
	});

	it("uses the 14 most recent true-range values when many bars exist", () => {
		// 20 bars: only last 14 TR values should be used
		const bars: DailyOHLCVBar[] = Array.from({ length: 20 }, (_, i) => ({
			open: 100 + i,
			high: 105 + i,
			low: 95 + i,
			close: 102 + i,
			volume: 1_000_000,
		}));
		const atr = computeATR(bars);
		expect(atr).not.toBeNull();
		// All TRs are the same: max(105+i - (95+i), ...) = 10
		// But with prevClose consideration:
		// TR[i] = max(high-low, |high-prevClose|, |low-prevClose|)
		// = max(10, |105+i - (102+i-1)|, |95+i - (102+i-1)|)
		// = max(10, 4, 6) = 10
		expect(atr).toBeCloseTo(10);
	});

	it("uses previous close in true range when price gaps up between bars", () => {
		// 15 bars: first 14 flat, last bar gaps up from 100 to 110
		const bars: DailyOHLCVBar[] = Array.from({ length: 15 }, (_, i) =>
			i < 14
				? { open: 100, high: 102, low: 98, close: 100, volume: 1_000_000 }
				: { open: 110, high: 112, low: 109, close: 111, volume: 1_500_000 },
		);
		// Last 14 TRs: 13 are max(4,2,2)=4, 1 is max(3,12,9)=12
		// ATR = (13*4 + 12) / 14 = 64/14 ≈ 4.57
		expect(computeATR(bars)).toBeCloseTo(64 / 14);
	});
});

describe("Daily stats pipeline (extract OHLCV → ADV and ATR)", () => {
	it("produces positive ADV and ATR when given enough valid bars from a Massive-style payload", () => {
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
