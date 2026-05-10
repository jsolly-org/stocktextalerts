import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const marketDataFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/providers/massive", () => ({
	marketDataFetch: marketDataFetchMock,
}));

type CalendarModule = typeof import("../../../src/lib/time/market-calendar");

describe("getUsMarketClosureInfoForInstant", () => {
	let calendar: CalendarModule;

	beforeEach(async () => {
		marketDataFetchMock.mockReset();
		marketDataFetchMock.mockResolvedValue([]);
		// The module caches `/v1/marketstatus/upcoming` for 12 hours; resetting
		// modules between tests forces a fresh fetch with each test's mock state.
		vi.resetModules();
		calendar = await import("../../../src/lib/time/market-calendar");
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
});
