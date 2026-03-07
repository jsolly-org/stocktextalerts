import { describe, expect, it } from "vitest";
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

describe("computeADV", () => {
	it("returns average of last 20 bars' volumes", () => {
		const bars = Array.from({ length: 25 }, (_, i) =>
			makeBar({ volume: (i + 1) * 100_000 }),
		);
		// Last 20 bars: volumes 600k..2500k
		const expected =
			Array.from({ length: 20 }, (_, i) => (i + 6) * 100_000).reduce(
				(a, b) => a + b,
				0,
			) / 20;
		expect(computeADV(bars)).toBeCloseTo(expected);
	});

	it("returns average of all bars when fewer than 20", () => {
		const bars = [makeBar({ volume: 500_000 }), makeBar({ volume: 1_500_000 })];
		expect(computeADV(bars)).toBe(1_000_000);
	});

	it("returns null for empty bars", () => {
		expect(computeADV([])).toBeNull();
	});

	it("skips zero/negative volumes", () => {
		const bars = [
			makeBar({ volume: 0 }),
			makeBar({ volume: -100 }),
			makeBar({ volume: 500_000 }),
		];
		expect(computeADV(bars)).toBe(500_000);
	});
});

describe("computeATR", () => {
	it("computes ATR from known OHLCV data", () => {
		// 3 bars: TR is max(H-L, |H-prevC|, |L-prevC|)
		const bars: DailyOHLCVBar[] = [
			{ open: 100, high: 105, low: 95, close: 102, volume: 1_000_000 },
			{ open: 103, high: 108, low: 100, close: 106, volume: 1_200_000 },
			{ open: 105, high: 110, low: 103, close: 107, volume: 900_000 },
		];
		// TR[1] = max(108-100, |108-102|, |100-102|) = max(8, 6, 2) = 8
		// TR[2] = max(110-103, |110-106|, |103-106|) = max(7, 4, 3) = 7
		// ATR = (8 + 7) / 2 = 7.5
		expect(computeATR(bars)).toBeCloseTo(7.5);
	});

	it("returns null for fewer than 2 bars", () => {
		expect(computeATR([])).toBeNull();
		expect(computeATR([makeBar()])).toBeNull();
	});

	it("uses up to 14 most recent TR values", () => {
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

	it("handles gap-up scenario (TR uses prev close)", () => {
		const bars: DailyOHLCVBar[] = [
			{ open: 100, high: 102, low: 98, close: 100, volume: 1_000_000 },
			{ open: 110, high: 112, low: 109, close: 111, volume: 1_500_000 },
		];
		// TR = max(112-109, |112-100|, |109-100|) = max(3, 12, 9) = 12
		expect(computeATR(bars)).toBeCloseTo(12);
	});
});
