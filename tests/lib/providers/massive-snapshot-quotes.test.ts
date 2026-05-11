import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshotQuotes } from "../../../src/lib/providers/massive";

// Mock retry delays so error/retry paths don't wait real seconds.
vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function snapshotResponse(tickers: unknown[]) {
	return new Response(JSON.stringify({ tickers }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("fetchSnapshotQuotes during pre-market hours", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses the latest pre-market minute bar when the regular-session day bar is empty", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Captured live at 07:00 ET pre-market: Polygon-compatible snapshot returns
		// `day: {c: 0}` because the regular session has not opened, but `min.c`
		// carries the most recent pre-market minute bar.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "RTX",
					todaysChangePerc: -0.1817252541314062,
					todaysChange: -0.32,
					updated: 1778495760000000000,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 175.77 },
					prevDay: { o: 176.22, h: 177.09, l: 174.6, c: 176.09, v: 6277446 },
				},
				{
					ticker: "PLTR",
					todaysChangePerc: -1.843251088534122,
					todaysChange: -2.54,
					updated: 1778496660000000000,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 135.26 },
					prevDay: { o: 135.865, h: 137.88, l: 133.02, c: 137.8, v: 41745393 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["RTX", "PLTR"]);

		const rtx = quotes.get("RTX");
		const pltr = quotes.get("PLTR");
		expect(rtx).not.toBeNull();
		expect(pltr).not.toBeNull();
		expect(rtx?.price).toBe(175.77);
		expect(rtx?.changePercent).toBeCloseTo(-0.18, 2);
		expect(rtx?.prevClose).toBe(176.09);
		expect(pltr?.price).toBe(135.26);
		expect(pltr?.changePercent).toBeCloseTo(-1.84, 2);
		expect(pltr?.prevClose).toBe(137.8);
	});

	it("derives the pre-market price from prevDay + todaysChange when the min bar is also zero", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Real-world edge case (BAH at 07:00 ET): the snapshot reports a non-zero
		// `todaysChange` (so the API knows the ticker has moved in pre-market)
		// while `day` and `min` are still flat at zero.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "BAH",
					todaysChangePerc: 0.8177570093457884,
					todaysChange: 0.63,
					updated: 1_778_486_450_150_750_000,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 0 },
					prevDay: { o: 76.23, h: 77.14, l: 74.88, c: 77.04, v: 1253720 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["BAH"]);

		const bah = quotes.get("BAH");
		expect(bah).not.toBeNull();
		expect(bah?.price).toBeCloseTo(77.67, 2);
		expect(bah?.changePercent).toBeCloseTo(0.82, 2);
	});

	it("returns null for tickers with no pre-market activity (day, min, and todaysChange all zero)", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// CACI/GD/SAIC at 07:00 ET: thinly-traded names with no pre-market prints yet.
		// Preserves existing behavior — caller renders "price unavailable".
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "CACI",
					todaysChangePerc: 0,
					todaysChange: 0,
					updated: 0,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 0 },
					prevDay: { o: 488.34, h: 488.44, l: 476.7, c: 480.99, v: 273618 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["CACI"]);
		expect(quotes.get("CACI")).toBeNull();
	});

	it("rejects derived prices that fall to zero or below from a catastrophic todaysChange", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Defends the derived-price arm: if a stock's reported todaysChange
		// would push the price to <= 0 (delisted/halted edge case), return
		// null rather than emit a $0.00 or negative price downstream.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "ZERO",
					todaysChangePerc: -100,
					todaysChange: -50,
					updated: 1_778_500_000_000_000_000,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 0 },
					prevDay: { o: 50, h: 50, l: 50, c: 50, v: 1_000 },
				},
				{
					ticker: "NEGATIVE",
					todaysChangePerc: -110,
					todaysChange: -55,
					updated: 1_778_500_000_000_000_000,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 0 },
					prevDay: { o: 50, h: 50, l: 50, c: 50, v: 1_000 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["ZERO", "NEGATIVE"]);
		expect(quotes.get("ZERO")).toBeNull();
		expect(quotes.get("NEGATIVE")).toBeNull();
	});

	it("uses the regular-session day.c during after-hours and ignores the later min.c bar", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Regression guard for the after-hours path. The displayed "current
		// price" comes from day.c (the 4:00 PM regular close); change-% is
		// computed elsewhere against fetchTodaysRegularCloses. The fallback
		// chain must NOT promote min.c to the price field after-hours.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "MSFT",
					todaysChangePerc: 1.0,
					todaysChange: 4.0,
					updated: 1_778_530_000_000_000_000,
					day: { o: 396, h: 416, l: 395, c: 415.2, v: 25_000_000 },
					min: { c: 416.5 },
					prevDay: { o: 410, h: 412, l: 408, c: 411.2, v: 30_000_000 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["MSFT"]);
		const msft = quotes.get("MSFT");
		expect(msft).not.toBeNull();
		expect(msft?.price).toBe(415.2);
	});

	it("keeps using day.c during the regular session", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Regular session: day.c is the rolling close and is the authoritative
		// price. Guards against accidentally regressing the regular-hours path
		// while fixing the pre-market path.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "SPY",
					todaysChangePerc: 0.5,
					todaysChange: 2.5,
					updated: 1778500000000000000,
					day: { o: 497.5, h: 501.25, l: 497.0, c: 500.5, v: 50_000_000 },
					min: { c: 500.4 },
					prevDay: { o: 496.0, h: 499.0, l: 495.5, c: 498.0, v: 60_000_000 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["SPY"]);
		const spy = quotes.get("SPY");
		expect(spy).not.toBeNull();
		expect(spy?.price).toBe(500.5);
		expect(spy?.changePercent).toBeCloseTo(0.5, 2);
		expect(spy?.dayOpen).toBe(497.5);
		expect(spy?.dayHigh).toBe(501.25);
		expect(spy?.dayLow).toBe(497.0);
	});
});
