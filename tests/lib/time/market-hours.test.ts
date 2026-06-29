import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { etMinuteToUserLocal, userLocalToEtMinute } from "../../../src/lib/time/conversion";
import {
	getLastMarketClose,
	getScheduledMarketSession,
	isOutsideMarketHours,
} from "../../../src/lib/time/market/session";

describe("isOutsideMarketHours", () => {
	// Notification window: 4:30 AM – 7:30 PM ET (ET-minutes [270, 1170])

	it("Noon ET is treated as inside the extended-hours window.", () => {
		const noon = 12 * 60;
		expect(isOutsideMarketHours(noon)).toBe(false);
	});

	it("4:30 AM ET (lower bound) is treated as inside the window.", () => {
		expect(isOutsideMarketHours(270)).toBe(false);
	});

	it("7:30 PM ET (upper bound) is treated as inside the window.", () => {
		expect(isOutsideMarketHours(1170)).toBe(false);
	});

	it("4:29 AM ET (one minute before lower bound) is treated as outside the window.", () => {
		expect(isOutsideMarketHours(269)).toBe(true);
	});

	it("7:31 PM ET (one minute after upper bound) is treated as outside the window.", () => {
		expect(isOutsideMarketHours(1171)).toBe(true);
	});

	it("9:30 AM ET (regular open) is treated as inside the extended-hours window.", () => {
		const marketOpen = 9 * 60 + 30;
		expect(isOutsideMarketHours(marketOpen)).toBe(false);
	});

	it("4:00 PM ET (regular close) is treated as inside the extended-hours window.", () => {
		const marketClose = 16 * 60;
		expect(isOutsideMarketHours(marketClose)).toBe(false);
	});

	it("Midnight (0 ET-minutes) is treated as outside the window.", () => {
		expect(isOutsideMarketHours(0)).toBe(true);
	});

	it("11:59 PM ET (1439 minutes) is treated as outside the window.", () => {
		expect(isOutsideMarketHours(1439)).toBe(true);
	});

	it("Negative input is treated as outside the window.", () => {
		expect(isOutsideMarketHours(-1)).toBe(true);
	});

	it("Out-of-range input (>= 1440) is treated as outside the window.", () => {
		expect(isOutsideMarketHours(1440)).toBe(true);
	});

	it("Non-integer input is treated as outside the window.", () => {
		expect(isOutsideMarketHours(12.5)).toBe(true);
	});
});

describe("etMinuteToUserLocal / userLocalToEtMinute round-trip", () => {
	it("A US-Eastern user round-trips ET-minute 600 (10:00 AM ET) to itself.", () => {
		const local = etMinuteToUserLocal(600, "America/New_York");
		expect(local).toBe(600);
		expect(userLocalToEtMinute(local, "America/New_York")).toBe(600);
	});

	it("A US-Pacific user sees ET-minute 600 (10:00 AM ET) as 7:00 AM PT (420).", () => {
		const local = etMinuteToUserLocal(600, "America/Los_Angeles");
		expect(local).toBe(420);
		expect(userLocalToEtMinute(420, "America/Los_Angeles")).toBe(600);
	});

	it("A Tokyo user sees ET-minute 540 (9:00 AM ET) as a wall-clock time that round-trips.", () => {
		const local = etMinuteToUserLocal(540, "Asia/Tokyo");
		expect(userLocalToEtMinute(local, "Asia/Tokyo")).toBe(540);
	});
});

describe("getScheduledMarketSession", () => {
	it("4:30 AM ET (earliest pickable time) is classified as pre-market.", () => {
		expect(getScheduledMarketSession(270)).toBe("pre");
	});

	it("9:29 AM ET (one minute before regular open) is classified as pre-market.", () => {
		expect(getScheduledMarketSession(569)).toBe("pre");
	});

	it("9:30 AM ET (regular open boundary) is classified as regular session.", () => {
		expect(getScheduledMarketSession(570)).toBe("regular");
	});

	it("9:31 AM ET (just after regular open) is classified as regular session.", () => {
		expect(getScheduledMarketSession(571)).toBe("regular");
	});

	it("Noon ET is classified as regular session.", () => {
		expect(getScheduledMarketSession(720)).toBe("regular");
	});

	it("3:59 PM ET (one minute before regular close) is classified as regular session.", () => {
		expect(getScheduledMarketSession(959)).toBe("regular");
	});

	it("4:00 PM ET (regular close boundary) is classified as after-hours.", () => {
		expect(getScheduledMarketSession(960)).toBe("after");
	});

	it("4:01 PM ET (just after regular close) is classified as after-hours.", () => {
		expect(getScheduledMarketSession(961)).toBe("after");
	});

	it("7:30 PM ET (latest pickable time) is classified as after-hours.", () => {
		expect(getScheduledMarketSession(1170)).toBe("after");
	});
});

describe("getLastMarketClose", () => {
	it("On spring-forward Sunday evening, returns Friday 4:00 PM ET — not an hour shifted by DST duration math.", () => {
		const sundayEvening = DateTime.fromISO("2026-03-08T21:00:00", {
			zone: "America/New_York",
		});
		const lastClose = getLastMarketClose(sundayEvening);
		expect(lastClose.toISO()).toBe("2026-03-06T16:00:00.000-05:00");
	});
});
