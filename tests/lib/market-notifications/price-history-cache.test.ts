import { describe, expect, it } from "vitest";
import {
	dailyBarsToCloseRows,
	formatChartAsOfLabel,
	INTRADAY_CACHE_MAX_AGE_MS,
	REQUIRED_DAILY_CLOSES,
} from "../../../src/lib/market-data/price-history-cache";
import { listTradingDatesBetween } from "../../helpers/market-data";

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

	it("uses the configured freshness and close-count cutoffs", () => {
		expect(INTRADAY_CACHE_MAX_AGE_MS).toBe(15 * 60 * 1000);
		expect(REQUIRED_DAILY_CLOSES).toBe(7);
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
