import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../src/lib/market-data/session");

const marketDataFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/vendors/massive", () => ({
	marketDataFetch: marketDataFetchMock,
}));

const isTestMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../../src/lib/runtime/mode", () => ({
	isTest: isTestMock,
}));

type MarketDataSession = typeof import("../../../src/lib/market-data/session");

/** Calendar record shape returned by Massive `/v1/marketstatus/upcoming`. */
type CalendarRecord = {
	exchange: string;
	date: string;
	status: "closed" | "early-close";
	name?: string;
	open?: string;
	close?: string;
};

describe("getCurrentMarketSession — local, no live vendor call", () => {
	let marketDataSession: MarketDataSession;

	async function sessionAt(isoUtc: string, calendar: CalendarRecord[] = []): Promise<string> {
		// Module-level calendar cache persists across imports; reset the graph so each
		// case gets a fresh cache and re-reads DateTime.utc() under fake timers.
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(DateTime.fromISO(isoUtc, { zone: "utc" }).toJSDate());
		marketDataFetchMock.mockReset();
		marketDataFetchMock.mockImplementation(async (path: string) => {
			if (path === "/v1/marketstatus/upcoming") return calendar;
			throw new Error(`unexpected Massive call in local session: ${path}`);
		});
		marketDataSession = await import("../../../src/lib/market-data/session");
		return marketDataSession.getCurrentMarketSession();
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("classifies a regular-session weekday afternoon as 'regular' (no /marketstatus/now call)", async () => {
		// Mon Jan 12 2026, 11:00 AM ET (EST = UTC-5) → 16:00 UTC.
		expect(await sessionAt("2026-01-12T16:00:00.000Z")).toBe("regular");
		// The session is computed locally now — the only vendor call is the cached calendar.
		const calledPaths = marketDataFetchMock.mock.calls.map((call) => call[0]);
		expect(calledPaths).not.toContain("/v1/marketstatus/now");
	});

	it("classifies pre-market (8:00 AM ET) as 'pre'", async () => {
		expect(await sessionAt("2026-01-12T13:00:00.000Z")).toBe("pre");
	});

	it("classifies after-hours (5:00 PM ET) as 'after'", async () => {
		expect(await sessionAt("2026-01-12T22:00:00.000Z")).toBe("after");
	});

	it("classifies the overnight dead zone (2:00 AM ET) as 'closed'", async () => {
		expect(await sessionAt("2026-01-12T07:00:00.000Z")).toBe("closed");
	});

	it("classifies a Saturday as 'closed' from the weekday check", async () => {
		// Sat Jan 10 2026, midday.
		expect(await sessionAt("2026-01-10T17:00:00.000Z")).toBe("closed");
	});

	it("classifies a full holiday as 'closed' from the calendar", async () => {
		// MLK Day, Mon Jan 19 2026, 11:00 AM ET.
		expect(
			await sessionAt("2026-01-19T16:00:00.000Z", [
				{
					exchange: "NYSE",
					date: "2026-01-19",
					status: "closed",
					name: "Martin Luther King Jr. Day",
				},
			]),
		).toBe("closed");
	});

	it("honors a half-day BEFORE its early close as 'regular'", async () => {
		// Day after Thanksgiving, Fri Nov 27 2026, 10:00 AM ET (early close 1pm ET = 18:00 UTC).
		expect(
			await sessionAt("2026-11-27T15:00:00.000Z", [
				{
					exchange: "NYSE",
					date: "2026-11-27",
					status: "early-close",
					name: "Day after Thanksgiving",
					open: "2026-11-27T14:30:00.000Z",
					close: "2026-11-27T18:00:00.000Z",
				},
			]),
		).toBe("regular");
	});

	it("forces a half-day AFTER its early close to 'closed' (no stale after-hours session)", async () => {
		// Same half-day, 2:00 PM ET (19:00 UTC) — one hour past the 1pm early close.
		expect(
			await sessionAt("2026-11-27T19:00:00.000Z", [
				{
					exchange: "NYSE",
					date: "2026-11-27",
					status: "early-close",
					name: "Day after Thanksgiving",
					open: "2026-11-27T14:30:00.000Z",
					close: "2026-11-27T18:00:00.000Z",
				},
			]),
		).toBe("closed");
	});

	it("handles the EST→EDT offset correctly (summer regular session)", async () => {
		// Wed Jul 15 2026, 11:00 AM ET (EDT = UTC-4) → 15:00 UTC. A fixed -5 offset would
		// misread this as 10:00 AM (still regular) — pick a boundary that would break:
		// 9:00 AM EDT = 13:00 UTC is 'pre'; a wrong -5 read (8:00 AM) is also 'pre', so use
		// the regular case plus an explicit close-boundary check below.
		expect(await sessionAt("2026-07-15T15:00:00.000Z")).toBe("regular");
		// 4:00 PM EDT (20:00 UTC) is exactly the close → 'after'. A -5 misread (3pm) would
		// wrongly say 'regular', so this pins DST handling.
		expect(await sessionAt("2026-07-15T20:00:00.000Z")).toBe("after");
	});
});
