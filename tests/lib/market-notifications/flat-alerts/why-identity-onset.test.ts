import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { identitySearchNames } from "../../../../src/lib/market-notifications/flat-alerts/why-identity";
import {
	deriveMoveOnsetEt,
	moveWindowXSearchDates,
} from "../../../../src/lib/market-notifications/flat-alerts/why-onset";
import type { IntradayBarsResult } from "../../../../src/lib/types";

describe("identitySearchNames", () => {
	it("includes legal name and ticker, drops cashtag forms", () => {
		const names = identitySearchNames({ symbol: "DELL", companyName: "Dell Technologies" });
		expect(names).toContain("DELL");
		expect(names).toContain("Dell Technologies");
		expect(names.some((n) => n === "$DELL" || n === "(DELL)")).toBe(false);
	});

	it("merges persisted brands without duplicating", () => {
		const names = identitySearchNames({
			symbol: "SPCX",
			companyName: "Space Exploration Technologies",
			persistedAliases: ["SpaceX", "SPCX"],
		});
		expect(names).toContain("SpaceX");
		expect(names.filter((n) => n.toLowerCase() === "spacex").length).toBe(1);
	});
});

describe("moveWindowXSearchDates", () => {
	/** Stand-in US market calendar: weekends closed, plus the given ET holiday dates. */
	function closureLookup(holidays: string[] = []) {
		return async (instant: DateTime) => {
			const et = instant.setZone("America/New_York");
			if (et.weekday === 6 || et.weekday === 7) return { reason: "weekend" as const };
			const iso = et.toISODate();
			if (iso && holidays.includes(iso)) {
				return { reason: "holiday" as const, holidayName: "Test Holiday" };
			}
			return null;
		};
	}

	it("binds from prior session through today ET", async () => {
		const wednesday = DateTime.fromISO("2026-08-12T18:00:00", { zone: "America/New_York" });
		expect(await moveWindowXSearchDates(wednesday, closureLookup())).toEqual({
			from_date: "2026-08-11",
			to_date: "2026-08-12",
		});
	});

	it("skips the weekend so Monday includes Friday", async () => {
		const monday = DateTime.fromISO("2026-08-10T10:00:00", { zone: "America/New_York" });
		expect(await moveWindowXSearchDates(monday, closureLookup())).toEqual({
			from_date: "2026-08-07",
			to_date: "2026-08-10",
		});
	});

	it("reaches back past a Monday holiday to Friday's session", async () => {
		// Tuesday after Labor Day 2026 (Mon 2026-09-07): last session is Fri 2026-09-04.
		const tuesday = DateTime.fromISO("2026-09-08T10:00:00", { zone: "America/New_York" });
		expect(await moveWindowXSearchDates(tuesday, closureLookup(["2026-09-07"]))).toEqual({
			from_date: "2026-09-04",
			to_date: "2026-09-08",
		});
	});

	it("counts a half day as a session, not a closure", async () => {
		// Mon 2026-11-30 → back past the weekend to the Black Friday half day.
		const monday = DateTime.fromISO("2026-11-30T10:00:00", { zone: "America/New_York" });
		const halfDayLookup = async (instant: DateTime) => {
			const et = instant.setZone("America/New_York");
			if (et.weekday === 6 || et.weekday === 7) return { reason: "weekend" as const };
			if (et.toISODate() === "2026-11-27") return { reason: "half-day-after-close" as const };
			return null;
		};
		expect(await moveWindowXSearchDates(monday, halfDayLookup)).toEqual({
			from_date: "2026-11-27",
			to_date: "2026-11-30",
		});
	});
});

describe("deriveMoveOnsetEt", () => {
	it("returns the first bar where half the session move is in", () => {
		const intraday: IntradayBarsResult = {
			closes: [100, 102, 106, 110],
			timestamps: null,
			startTimestamp: 1,
			endTimestamp: 4,
			candles: [
				{ o: 100, h: 101, l: 99, c: 100, t: Date.parse("2026-08-12T14:30:00Z") },
				{ o: 100, h: 103, l: 100, c: 102, t: Date.parse("2026-08-12T14:45:00Z") },
				{ o: 102, h: 107, l: 102, c: 106, t: Date.parse("2026-08-12T15:00:00Z") },
				{ o: 106, h: 111, l: 106, c: 110, t: Date.parse("2026-08-12T15:15:00Z") },
			],
		};
		// 100 → 110 is +10; half at 105, first bar at/above is 15:00 UTC = 11:00 ET
		expect(deriveMoveOnsetEt(intraday)).toBe("11:00 ET");
	});

	it("returns null when there are no timestamps", () => {
		const intraday: IntradayBarsResult = {
			closes: [100, 110],
			timestamps: null,
			startTimestamp: null,
			endTimestamp: null,
			candles: null,
		};
		expect(deriveMoveOnsetEt(intraday)).toBeNull();
	});
});
