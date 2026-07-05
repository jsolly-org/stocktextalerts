import { describe, expect, it } from "vitest";
import {
	bucketSamplesToCandles,
	dailyBarsToCloseRows,
	formatChartAsOfLabel,
} from "../../../src/lib/market-data/price-history-cache";
import { listTradingDatesBetween } from "../../helpers/market-data";

const FIVE_MIN = 5 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 2, 13, 30, 0); // 09:30 ET session open

describe("price history cache helpers", () => {
	it("lists weekday trading dates between two ISO dates", () => {
		const dates = listTradingDatesBetween("2026-06-01", "2026-06-07");
		expect(dates).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]);
	});

	it("formats chart-as-of labels in the user's timezone", () => {
		const label = formatChartAsOfLabel("2026-06-07T13:42:00.000Z", "America/New_York", false);
		expect(label).toMatch(/^chart as of /);
		expect(label).toMatch(/EDT|EST/);
	});

	it("maps OHLCV bars to dated close rows using bar tradingDate", () => {
		const rows = dailyBarsToCloseRows("AAPL", [
			{
				open: 1,
				high: 2,
				low: 1,
				close: 1.5,
				volume: 100,
				tradingDate: "2026-06-02",
			},
			{
				open: 2,
				high: 3,
				low: 2,
				close: 2.5,
				volume: 200,
			},
		]);
		expect(rows).toEqual([{ symbol: "AAPL", trading_date: "2026-06-02", close: 1.5 }]);
	});
});

describe("bucketSamplesToCandles", () => {
	it("aggregates minute samples into 5-minute OHLC candles (open=first, close=last, high/low=extent)", () => {
		const samples = [
			{ price: 100, t: T0 + 0 * 60_000 },
			{ price: 103, t: T0 + 1 * 60_000 },
			{ price: 98, t: T0 + 2 * 60_000 },
			{ price: 101, t: T0 + 4 * 60_000 }, // still bucket 0 (minutes 0-4)
			{ price: 105, t: T0 + 5 * 60_000 }, // bucket 1 opens
			{ price: 104, t: T0 + 6 * 60_000 },
		];
		const candles = bucketSamplesToCandles(samples, FIVE_MIN);
		expect(candles).toEqual([
			{ o: 100, h: 103, l: 98, c: 101, t: T0 },
			{ o: 105, h: 105, l: 104, c: 104, t: T0 + FIVE_MIN },
		]);
	});

	it("returns candles sorted by time and skips non-finite prices", () => {
		const samples = [
			{ price: 50, t: T0 + 5 * 60_000 },
			{ price: Number.NaN, t: T0 + 1 * 60_000 },
			{ price: 42, t: T0 + 0 * 60_000 },
		];
		const candles = bucketSamplesToCandles(samples, FIVE_MIN);
		expect(candles.map((c) => c.t)).toEqual([T0, T0 + FIVE_MIN]);
		expect(candles[0]).toEqual({ o: 42, h: 42, l: 42, c: 42, t: T0 });
	});

	it("returns an empty array for no samples", () => {
		expect(bucketSamplesToCandles([], FIVE_MIN)).toEqual([]);
	});
});
