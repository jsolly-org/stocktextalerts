import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/runtime/mode", () => ({
	isTest: () => false,
}));

vi.mock("../../../src/lib/providers/massive", () => ({
	fetchIntradayBars: vi.fn(),
	fetchDailyCloses: vi.fn(),
	fetchPrevDayBar: vi.fn(),
	fetchSnapshotQuotes: vi.fn(),
	marketDataFetch: vi.fn(),
	NO_SESSION_TRADE: "no_session_trade",
	US_MARKET_TIMEZONE: "America/New_York",
}));

import { fetchIntradayBars } from "../../../src/lib/providers/massive";
import { fetchIntradaySparklines } from "../../../src/lib/providers/price-fetcher";

describe("A subscriber in early pre-market receives a notification before any 5-minute bar has closed", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("Drops the sparkline entirely when prev close is known but Massive has not yet returned any intraday bars", async () => {
		// 4:05 AM ET: the snapshot returns yesterday's close, but the
		// /range/5/minute aggregates endpoint hasn't recorded a single bar
		// for today's session yet. Prepending only prev close would yield a
		// 1-element array, which `toSparkline` (length < 2 guard) rejects.
		vi.mocked(fetchIntradayBars).mockResolvedValueOnce(null);

		const prevCloseMap = new Map<string, number | null | undefined>([["LDOS", 178.42]]);
		const result = await fetchIntradaySparklines(["LDOS"], prevCloseMap);

		expect(result.get("LDOS")).toBeNull();
	});

	it("Renders a 2-point chart when Massive returns one bar after the first 5-minute interval closes", async () => {
		vi.mocked(fetchIntradayBars).mockResolvedValueOnce({
			closes: [177.85],
			timestamps: [Date.UTC(2026, 0, 12, 9, 35)],
			startTimestamp: Date.UTC(2026, 0, 12, 9, 35),
			endTimestamp: Date.UTC(2026, 0, 12, 9, 35),
		});

		const prevCloseMap = new Map<string, number | null | undefined>([["LDOS", 178.42]]);
		const result = await fetchIntradaySparklines(["LDOS"], prevCloseMap);

		const entry = result.get("LDOS");
		expect(entry).not.toBeNull();
		expect(entry?.values).toEqual([178.42, 177.85]);
		expect(entry?.window).toBe("intraday-since-prev-close");
	});

	it("Falls back to today-since-open when Massive returns intraday bars but the snapshot did not include a prev close (delisted/fresh listing)", async () => {
		vi.mocked(fetchIntradayBars).mockResolvedValueOnce({
			closes: [12.5, 12.7, 12.6, 12.9, 13.1],
			timestamps: [
				Date.UTC(2026, 0, 12, 14, 35),
				Date.UTC(2026, 0, 12, 14, 40),
				Date.UTC(2026, 0, 12, 14, 45),
				Date.UTC(2026, 0, 12, 14, 50),
				Date.UTC(2026, 0, 12, 14, 55),
			],
			startTimestamp: Date.UTC(2026, 0, 12, 14, 35),
			endTimestamp: Date.UTC(2026, 0, 12, 14, 55),
		});

		const prevCloseMap = new Map<string, number | null | undefined>([["NEWCO", null]]);
		const result = await fetchIntradaySparklines(["NEWCO"], prevCloseMap);

		const entry = result.get("NEWCO");
		expect(entry).not.toBeNull();
		expect(entry?.values).toEqual([12.5, 12.7, 12.6, 12.9, 13.1]);
		expect(entry?.window).toBe("intraday-since-open");
	});

	it("Drops the sparkline entirely when neither prev close nor intraday bars are available", async () => {
		vi.mocked(fetchIntradayBars).mockResolvedValueOnce(null);

		const prevCloseMap = new Map<string, number | null | undefined>([["GHOST", null]]);
		const result = await fetchIntradaySparklines(["GHOST"], prevCloseMap);

		expect(result.get("GHOST")).toBeNull();
	});
});
