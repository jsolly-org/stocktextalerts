import { describe, expect, it } from "vitest";
import {
	extractIntradayOHLCV,
	extractOHLCVFromBars,
} from "../../../src/lib/market-data/bars-parse";

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
			tradingDate: "2023-11-14",
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

describe("Intraday OHLC candle extraction for the Telegram candlestick chart", () => {
	it("parses per-bar o/h/l/c/t from a 5-minute aggregates payload", () => {
		// Two 5-minute bars during the LDOS session, sort=asc as Massive returns them.
		const t1 = Date.UTC(2026, 5, 19, 14, 35); // 10:35 ET
		const t2 = Date.UTC(2026, 5, 19, 14, 40); // 10:40 ET
		const candles = extractIntradayOHLCV({
			results: [
				{ o: 172.0, h: 173.4, l: 171.2, c: 172.8, v: 18_500, t: t1 },
				{ o: 172.8, h: 174.1, l: 172.5, c: 173.9, v: 21_300, t: t2 },
			],
		});

		expect(candles).not.toBeNull();
		expect(candles).toHaveLength(2);
		// Volume is intentionally dropped — the chart needs only o/h/l/c/t.
		expect(candles?.[0]).toEqual({ o: 172.0, h: 173.4, l: 171.2, c: 172.8, t: t1 });
		expect(candles?.[1]).toEqual({ o: 172.8, h: 174.1, l: 172.5, c: 173.9, t: t2 });
	});

	it("returns null for invalid or empty payloads", () => {
		expect(extractIntradayOHLCV(null)).toBeNull();
		expect(extractIntradayOHLCV("not an object")).toBeNull();
		expect(extractIntradayOHLCV({ results: [] })).toBeNull();
		// A bar missing its timestamp is dropped (the chart's x-axis needs t).
		expect(extractIntradayOHLCV({ results: [{ o: 1, h: 2, l: 1, c: 2, v: 5 }] })).toBeNull();
	});

	it("skips bars lacking a finite OHLC field and keeps the valid candles", () => {
		const t1 = Date.UTC(2026, 5, 19, 14, 35);
		const t3 = Date.UTC(2026, 5, 19, 14, 45);
		const candles = extractIntradayOHLCV({
			results: [
				{ o: 10, h: 11, l: 9, c: 10.5, t: t1 },
				{ o: 10.5, h: "bad", l: 10, c: 10.8, t: Date.UTC(2026, 5, 19, 14, 40) },
				{ o: 10.8, h: 12, l: 10.6, c: 11.7, t: t3 },
			],
		});

		expect(candles).toHaveLength(2);
		expect(candles?.[0]?.t).toBe(t1);
		expect(candles?.[1]?.t).toBe(t3);
	});
});
