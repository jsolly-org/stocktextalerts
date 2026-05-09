import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/time/market-calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn(),
}));

import { getUsMarketClosureInfoForInstant } from "../../../src/lib/time/market-calendar";
import { calculateNextMarketScheduledSendAtFromTimes } from "../../../src/lib/time/market-scheduled-next-send";

const mockedGetClosure = vi.mocked(getUsMarketClosureInfoForInstant);

describe("calculateNextMarketScheduledSendAtFromTimes", () => {
	beforeEach(() => {
		mockedGetClosure.mockReset();
		// Default: market is open (no closure)
		mockedGetClosure.mockResolvedValue(null);
	});

	it("skips weekend slots and returns Monday for Saturday schedule", async () => {
		// Saturday and Sunday are weekends
		mockedGetClosure.mockImplementation(async (instant) => {
			const eastern = instant.setZone("America/New_York");
			if (eastern.weekday === 6 || eastern.weekday === 7) {
				return { reason: "weekend" };
			}
			return null;
		});

		const now = DateTime.fromISO("2026-02-14T14:00:00Z"); // Saturday 9:00 AM ET
		const result = await calculateNextMarketScheduledSendAtFromTimes({
			etMinutesList: [9 * 60 + 30],
			now,
		});

		expect(result.delayReasons).toEqual(["weekend"]);
		expect(result.nextSendAt?.setZone("America/New_York").toISO()).toBe(
			"2026-02-16T09:30:00.000-05:00",
		);
	});

	it("reports holiday delay when the next slot is a market holiday", async () => {
		mockedGetClosure.mockImplementation(async (instant) => {
			const eastern = instant.setZone("America/New_York");
			const isoDate = eastern.toISODate();
			if (isoDate === "2027-01-18") {
				return {
					reason: "holiday",
					holidayName: "Martin Luther King Jr. Day",
				};
			}
			return null;
		});

		const now = DateTime.fromISO("2027-01-18T13:00:00Z"); // Monday 8:00 AM ET (holiday)
		const result = await calculateNextMarketScheduledSendAtFromTimes({
			etMinutesList: [9 * 60 + 30],
			now,
		});

		expect(result.delayReasons).toEqual(["holiday"]);
		expect(result.holidayName).toBe("Martin Luther King Jr. Day");
		expect(result.nextSendAt?.setZone("America/New_York").toISO()).toBe(
			"2027-01-19T09:30:00.000-05:00",
		);
	});

	it("reports both weekend and holiday when Monday is a holiday", async () => {
		mockedGetClosure.mockImplementation(async (instant) => {
			const eastern = instant.setZone("America/New_York");
			if (eastern.weekday === 6 || eastern.weekday === 7) {
				return { reason: "weekend" };
			}
			const isoDate = eastern.toISODate();
			if (isoDate === "2026-02-16") {
				return { reason: "holiday", holidayName: "Presidents' Day" };
			}
			return null;
		});

		// Saturday — next candidate is Sunday (weekend), then Monday (holiday)
		const now = DateTime.fromISO("2026-02-14T14:00:00Z"); // Saturday 9:00 AM ET
		const result = await calculateNextMarketScheduledSendAtFromTimes({
			etMinutesList: [9 * 60 + 30],
			now,
		});

		expect(result.delayReasons).toEqual(["weekend", "holiday"]);
		expect(result.holidayName).toBe("Presidents' Day");
		expect(result.nextSendAt?.setZone("America/New_York").toISO()).toBe(
			"2026-02-17T09:30:00.000-05:00",
		);
	});

	it("returns no holiday name when API omits name", async () => {
		mockedGetClosure.mockImplementation(async (instant) => {
			const eastern = instant.setZone("America/New_York");
			const isoDate = eastern.toISODate();
			if (isoDate === "2027-01-18") {
				return { reason: "holiday" };
			}
			return null;
		});

		const now = DateTime.fromISO("2027-01-18T13:00:00Z");
		const result = await calculateNextMarketScheduledSendAtFromTimes({
			etMinutesList: [9 * 60 + 30],
			now,
		});

		expect(result.delayReasons).toEqual(["holiday"]);
		expect(result.holidayName).toBeUndefined();
	});
});
