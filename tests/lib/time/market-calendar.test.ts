import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const marketDataFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/vendors/massive", () => ({
	marketDataFetch: marketDataFetchMock,
}));

type CalendarModule = typeof import("../../../src/lib/time/market/calendar");

describe("getUsMarketClosureInfoForInstant", () => {
	let calendar: CalendarModule;

	beforeEach(async () => {
		marketDataFetchMock.mockReset();
		marketDataFetchMock.mockResolvedValue([]);
		// The module caches `/v1/marketstatus/upcoming` for 12 hours; resetting
		// modules between tests forces a fresh fetch with each test's mock state.
		vi.resetModules();
		calendar = await import("../../../src/lib/time/market/calendar");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("On Saturday, returns { reason: 'weekend' } regardless of holidays endpoint state", async () => {
		const saturdayNoonEt = DateTime.fromISO("2026-01-10T17:00:00.000Z", { zone: "utc" });
		const result = await calendar.getUsMarketClosureInfoForInstant(saturdayNoonEt);
		expect(result).toEqual({ reason: "weekend" });
	});

	it("On a full-closure holiday from Massive's upcoming endpoint, returns { reason: 'holiday', holidayName }", async () => {
		marketDataFetchMock.mockResolvedValueOnce([
			{
				exchange: "NYSE",
				date: "2026-11-26",
				status: "closed",
				name: "Thanksgiving",
			},
		]);
		// Thursday Nov 26, 2026 — 10am ET → 15:00 UTC
		const thanksgivingMorningEt = DateTime.fromISO("2026-11-26T15:00:00.000Z", { zone: "utc" });
		const result = await calendar.getUsMarketClosureInfoForInstant(thanksgivingMorningEt);
		expect(result).toEqual({ reason: "holiday", holidayName: "Thanksgiving" });
	});

	it("On a half-day past the early close (e.g. 2pm ET on day after Thanksgiving), returns { reason: 'half-day-after-close' }", async () => {
		marketDataFetchMock.mockResolvedValueOnce([
			{
				exchange: "NYSE",
				date: "2026-11-27",
				status: "early-close",
				name: "Day after Thanksgiving",
				open: "2026-11-27T14:30:00.000Z",
				close: "2026-11-27T18:00:00.000Z",
			},
		]);
		// 2pm ET on Nov 27 = 19:00 UTC, an hour past the 18:00 UTC early close.
		const halfDayDeadZoneEt = DateTime.fromISO("2026-11-27T19:00:00.000Z", { zone: "utc" });
		const result = await calendar.getUsMarketClosureInfoForInstant(halfDayDeadZoneEt);
		expect(result).toEqual({
			reason: "half-day-after-close",
			holidayName: "Day after Thanksgiving",
		});
	});

	it("On a half-day BEFORE the early close (e.g. 10am ET on day after Thanksgiving), returns null — market is open this morning", async () => {
		marketDataFetchMock.mockResolvedValueOnce([
			{
				exchange: "NYSE",
				date: "2026-11-27",
				status: "early-close",
				name: "Day after Thanksgiving",
				open: "2026-11-27T14:30:00.000Z",
				close: "2026-11-27T18:00:00.000Z",
			},
		]);
		// 10am ET on Nov 27 = 15:00 UTC, well before the 18:00 UTC early close.
		const halfDayMorningEt = DateTime.fromISO("2026-11-27T15:00:00.000Z", { zone: "utc" });
		const result = await calendar.getUsMarketClosureInfoForInstant(halfDayMorningEt);
		expect(result).toBeNull();
	});

	it("On a regular trading weekday with no holiday/half-day records, returns null", async () => {
		// Monday Jan 12, 2026 — 10am ET → 15:00 UTC
		const regularWeekdayMorningEt = DateTime.fromISO("2026-01-12T15:00:00.000Z", { zone: "utc" });
		const result = await calendar.getUsMarketClosureInfoForInstant(regularWeekdayMorningEt);
		expect(result).toBeNull();
	});

	it("When Massive returns null on a weekday, a second lookup within the failure TTL does not refetch", async () => {
		marketDataFetchMock.mockResolvedValue(null);
		const mondayMorningEt = DateTime.fromISO("2026-01-12T15:00:00.000Z", { zone: "utc" });

		const first = await calendar.getUsMarketClosureInfoForInstant(mondayMorningEt);
		const second = await calendar.getUsMarketClosureInfoForInstant(mondayMorningEt);

		expect(first).toBeNull();
		expect(second).toBeNull();
		expect(marketDataFetchMock).toHaveBeenCalledTimes(1);
	});

	it("When a refresh fails after a successful holiday fetch, stale closure records are retained briefly", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-26T15:00:00.000Z"));

		marketDataFetchMock.mockResolvedValueOnce([
			{
				exchange: "NYSE",
				date: "2026-11-26",
				status: "closed",
				name: "Thanksgiving",
			},
		]);
		const thanksgivingMorningEt = DateTime.fromISO("2026-11-26T15:00:00.000Z", { zone: "utc" });
		const first = await calendar.getUsMarketClosureInfoForInstant(thanksgivingMorningEt);
		expect(first).toEqual({ reason: "holiday", holidayName: "Thanksgiving" });
		expect(marketDataFetchMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1);
		marketDataFetchMock.mockResolvedValueOnce(null);
		const second = await calendar.getUsMarketClosureInfoForInstant(thanksgivingMorningEt);
		expect(second).toEqual({ reason: "holiday", holidayName: "Thanksgiving" });
		expect(marketDataFetchMock).toHaveBeenCalledTimes(2);
	});

	it("On Saturday, does not call Massive even when the holidays endpoint would fail", async () => {
		marketDataFetchMock.mockResolvedValue(null);
		const saturdayNoonEt = DateTime.fromISO("2026-01-10T17:00:00.000Z", { zone: "utc" });
		const result = await calendar.getUsMarketClosureInfoForInstant(saturdayNoonEt);
		expect(result).toEqual({ reason: "weekend" });
		expect(marketDataFetchMock).not.toHaveBeenCalled();
	});
});
