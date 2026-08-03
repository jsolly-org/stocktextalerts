import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
	addWeekdays,
	getNextFinraShortInterestCycle,
	isFinraPublishInCalendarWindow,
	listFinraShortInterestCyclesInRange,
	previousWeekdayOnOrBefore,
} from "../../../src/lib/asset-events/finra-short-interest-calendar";
import {
	formatShortInterestSectionLines,
	formatShortInterestSectionTitle,
} from "../../../src/lib/asset-events/short-interest";

describe("FINRA short-interest calendar", () => {
	it("maps Jul 15 2026 settlement to Jul 24 publish (7 weekdays later)", () => {
		const cycles = listFinraShortInterestCyclesInRange("2026-07-24", "2026-07-24");
		expect(cycles).toEqual([{ settlementDate: "2026-07-15", publishDate: "2026-07-24" }]);
	});

	it("maps Jul 31 2026 settlement to Aug 11 publish", () => {
		const cycles = listFinraShortInterestCyclesInRange("2026-08-11", "2026-08-11");
		expect(cycles).toEqual([{ settlementDate: "2026-07-31", publishDate: "2026-08-11" }]);
	});

	it("moves mid-month settlement off weekends", () => {
		// 2026-02-15 is Sunday → prior weekday Friday Feb 13
		const settlement = previousWeekdayOnOrBefore(DateTime.utc(2026, 2, 15));
		expect(settlement.toISODate()).toBe("2026-02-13");
	});

	it("addWeekdays skips weekends", () => {
		const friday = DateTime.utc(2026, 7, 31);
		expect(addWeekdays(friday, 1).toISODate()).toBe("2026-08-03");
		expect(addWeekdays(friday, 7).toISODate()).toBe("2026-08-11");
	});

	it("getNextFinraShortInterestCycle returns the upcoming publish on or after localDate", () => {
		expect(getNextFinraShortInterestCycle("2026-08-10")).toEqual({
			settlementDate: "2026-07-31",
			publishDate: "2026-08-11",
		});
		expect(getNextFinraShortInterestCycle("2026-08-11")).toEqual({
			settlementDate: "2026-07-31",
			publishDate: "2026-08-11",
		});
	});

	it("isFinraPublishInCalendarWindow matches the asset-events 3-day lookahead", () => {
		expect(isFinraPublishInCalendarWindow("2026-08-09", "2026-08-11")).toBe(true);
		expect(isFinraPublishInCalendarWindow("2026-08-11", "2026-08-11")).toBe(true);
		expect(isFinraPublishInCalendarWindow("2026-08-08", "2026-08-11")).toBe(false);
		expect(isFinraPublishInCalendarWindow("2026-08-12", "2026-08-11")).toBe(false);
	});
});

describe("short interest section formatters", () => {
	it("formats heads-up copy with publish and settlement labels", () => {
		const content = {
			mode: "heads_up" as const,
			publishDate: "2026-08-11",
			settlementDate: "2026-07-31",
			lines: null,
		};
		expect(formatShortInterestSectionTitle(content)).toBe("Short Interest");
		expect(formatShortInterestSectionLines(content)).toBe(
			"FINRA publishes the next short-interest report on Aug 11\n(settlement Jul 31)",
		);
	});

	it("formats report title with as-of and body as watchlist lines", () => {
		const content = {
			mode: "report" as const,
			publishDate: "2026-08-11",
			settlementDate: "2026-07-31",
			lines: [
				{ symbol: "BAH", text: "BAH — 7.6% of shares · 4.2 days to cover" },
				{ symbol: "NVDA", text: "NVDA — 1.3% of shares · 2.5 days to cover" },
			],
		};
		expect(formatShortInterestSectionTitle(content)).toBe(
			"Short Interest (as of Jul 31 · published Aug 11)",
		);
		expect(formatShortInterestSectionLines(content)).toBe(
			"BAH — 7.6% of shares · 4.2 days to cover\nNVDA — 1.3% of shares · 2.5 days to cover",
		);
	});
});
