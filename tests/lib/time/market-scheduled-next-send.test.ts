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

	it("On Friday evening before the spring-forward weekend, next_send_at lands at Monday 09:30 EDT — only 60h 30m of UTC away (one hour was lost to DST).", async () => {
		// US spring-forward: Sunday 2026-03-08, 02:00 EST → 03:00 EDT.
		// Naive wall-clock counting Fri 8 PM → Mon 9:30 AM is 61.5 hours; the actual
		// elapsed UTC time is 60.5 hours because DST consumed one of those hours.
		mockedGetClosure.mockImplementation(async (instant) => {
			const eastern = instant.setZone("America/New_York");
			if (eastern.weekday === 6 || eastern.weekday === 7) {
				return { reason: "weekend" };
			}
			return null;
		});

		const now = DateTime.fromISO("2026-03-07T01:00:00Z"); // Fri Mar 6, 8:00 PM EST
		const result = await calculateNextMarketScheduledSendAtFromTimes({
			etMinutesList: [9 * 60 + 30],
			now,
		});

		expect(result.delayReasons).toEqual(["weekend"]);
		expect(result.nextSendAt?.toISO()).toBe("2026-03-09T13:30:00.000Z"); // Mon 09:30 EDT
		const elapsedHours = result.nextSendAt ? result.nextSendAt.diff(now, "hours").hours : null;
		expect(elapsedHours).toBeCloseTo(60.5, 5);
	});

	it("On Friday evening before the fall-back weekend, next_send_at lands at Monday 09:30 EST — 62h 30m of UTC away (one hour was gained from DST).", async () => {
		// US fall-back: Sunday 2026-11-01, 02:00 EDT → 01:00 EST.
		// Naive wall-clock counting Fri 8 PM → Mon 9:30 AM is 61.5 hours; the actual
		// elapsed UTC time is 62.5 hours because the duplicated 01:00 hour added time.
		mockedGetClosure.mockImplementation(async (instant) => {
			const eastern = instant.setZone("America/New_York");
			if (eastern.weekday === 6 || eastern.weekday === 7) {
				return { reason: "weekend" };
			}
			return null;
		});

		const now = DateTime.fromISO("2026-10-31T00:00:00Z"); // Fri Oct 30, 8:00 PM EDT
		const result = await calculateNextMarketScheduledSendAtFromTimes({
			etMinutesList: [9 * 60 + 30],
			now,
		});

		expect(result.delayReasons).toEqual(["weekend"]);
		expect(result.nextSendAt?.toISO()).toBe("2026-11-02T14:30:00.000Z"); // Mon 09:30 EST
		const elapsedHours = result.nextSendAt ? result.nextSendAt.diff(now, "hours").hours : null;
		expect(elapsedHours).toBeCloseTo(62.5, 5);
	});
});
