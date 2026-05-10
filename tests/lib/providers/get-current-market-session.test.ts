import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const marketDataFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/providers/massive", () => ({
	marketDataFetch: marketDataFetchMock,
	// `getCurrentMarketSession` only uses marketDataFetch from this module;
	// the others stay un-stubbed (unused in this file's import graph).
	fetchDailyCloses: vi.fn(),
	fetchPrevDayBar: vi.fn(),
	fetchSnapshotQuotes: vi.fn(),
	fetchTodaysRegularClose: vi.fn(),
}));

const isTestMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../../src/lib/runtime/mode", () => ({
	isTest: isTestMock,
}));

type PriceFetcher = typeof import("../../../src/lib/providers/price-fetcher");

describe("getCurrentMarketSession — calendar-aware half-day override", () => {
	let priceFetcher: PriceFetcher;
	let now: DateTime;

	beforeEach(async () => {
		marketDataFetchMock.mockReset();
		isTestMock.mockReturnValue(false);
		// Module-level cache in market-calendar persists across tests; reset
		// the module graph so each test gets a fresh cache + fresh DateTime.utc().
		vi.resetModules();
		vi.useFakeTimers();
		priceFetcher = await import("../../../src/lib/providers/price-fetcher");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("On a half-day after the early close, even when Massive reports afterHours: true, the session is overridden to 'closed'", async () => {
		// 2:00 PM ET on Friday Nov 27, 2026 (half-day after Thanksgiving).
		// The early close was at 18:00 UTC (1pm ET); we're an hour past it.
		now = DateTime.fromISO("2026-11-27T19:00:00.000Z", { zone: "utc" });
		vi.setSystemTime(now.toJSDate());

		marketDataFetchMock.mockImplementation(async (path: string) => {
			if (path === "/v1/marketstatus/now") {
				// Hypothetical worst-case: Massive flags afterHours during the
				// half-day dead zone. The override should take over.
				return { market: "extended-hours", earlyHours: false, afterHours: true };
			}
			if (path === "/v1/marketstatus/upcoming") {
				return [
					{
						exchange: "NYSE",
						date: "2026-11-27",
						status: "early-close",
						name: "Day after Thanksgiving",
						open: "2026-11-27T14:30:00.000Z",
						close: "2026-11-27T18:00:00.000Z",
					},
				];
			}
			throw new Error(`unexpected path ${path}`);
		});

		const session = await priceFetcher.getCurrentMarketSession();
		expect(session).toBe("closed");
	});

	it("On a half-day BEFORE the early close, Massive's response is honored — the override does NOT fire", async () => {
		// 10:00 AM ET on Nov 27, 2026 — regular session is in effect.
		now = DateTime.fromISO("2026-11-27T15:00:00.000Z", { zone: "utc" });
		vi.setSystemTime(now.toJSDate());

		marketDataFetchMock.mockImplementation(async (path: string) => {
			if (path === "/v1/marketstatus/now") {
				return { market: "open", earlyHours: false, afterHours: false };
			}
			if (path === "/v1/marketstatus/upcoming") {
				return [
					{
						exchange: "NYSE",
						date: "2026-11-27",
						status: "early-close",
						name: "Day after Thanksgiving",
						open: "2026-11-27T14:30:00.000Z",
						close: "2026-11-27T18:00:00.000Z",
					},
				];
			}
			throw new Error(`unexpected path ${path}`);
		});

		const session = await priceFetcher.getCurrentMarketSession();
		expect(session).toBe("regular");
	});

	it("On a regular trading day, Massive's afterHours: true is honored — the override does NOT fire", async () => {
		// 5:00 PM ET on a regular Monday (Jan 12, 2026).
		now = DateTime.fromISO("2026-01-12T22:00:00.000Z", { zone: "utc" });
		vi.setSystemTime(now.toJSDate());

		marketDataFetchMock.mockImplementation(async (path: string) => {
			if (path === "/v1/marketstatus/now") {
				return { market: "extended-hours", earlyHours: false, afterHours: true };
			}
			if (path === "/v1/marketstatus/upcoming") {
				return [];
			}
			throw new Error(`unexpected path ${path}`);
		});

		const session = await priceFetcher.getCurrentMarketSession();
		expect(session).toBe("after");
	});
});
