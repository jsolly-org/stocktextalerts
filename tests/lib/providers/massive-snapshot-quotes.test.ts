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

/** Narrow a snapshot map entry to its live-quote variant, failing the test otherwise. */
function expectQuote<T>(entry: T | "no_session_trade" | null | undefined): T {
	expect(entry).not.toBeNull();
	expect(entry).not.toBe("no_session_trade");
	return entry as T;
}

describe("fetchSnapshotQuotes session-aware price resolution", () => {
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
					updated: 1778495760000000000,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 175.77 },
					prevDay: { o: 176.22, h: 177.09, l: 174.6, c: 176.09, v: 6277446 },
				},
				{
					ticker: "PLTR",
					todaysChangePerc: -1.843251088534122,
					updated: 1778496660000000000,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 135.26 },
					prevDay: { o: 135.865, h: 137.88, l: 133.02, c: 137.8, v: 41745393 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["RTX", "PLTR"], "pre");

		const rtx = expectQuote(quotes.get("RTX"));
		const pltr = expectQuote(quotes.get("PLTR"));
		expect(rtx.price).toBe(175.77);
		expect(rtx.changePercent).toBeCloseTo(-0.18, 2);
		expect(rtx.prevClose).toBe(176.09);
		expect(pltr.price).toBe(135.26);
		expect(pltr.changePercent).toBeCloseTo(-1.84, 2);
		expect(pltr.prevClose).toBe(137.8);
	});

	it("flags no_session_trade when Massive reports a change but no live minute bar yet", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Real-world edge case (BAH at 07:00 ET): the snapshot reports a non-zero
		// `todaysChange` (so Massive thinks the ticker has moved in pre-market)
		// while `day` and `min` are still flat at zero. Massive returned the
		// ticker entry — we know it's a tradable symbol — but there's no live
		// trade in this session. Renderer should distinguish this from a true
		// fetch miss.
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

		const quotes = await fetchSnapshotQuotes(["BAH"], "pre");
		expect(quotes.get("BAH")).toBe("no_session_trade");
	});

	it("flags no_session_trade for tickers with no pre-market activity (day and min both zero)", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// CACI/GD/SAIC at 07:00 ET: thinly-traded names with no pre-market prints yet.
		// Caller renders "no pre-market trades" rather than the generic
		// "price unavailable" used for fetch failures.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "CACI",
					todaysChangePerc: 0,
					updated: 0,
					day: { o: 0, h: 0, l: 0, c: 0, v: 0 },
					min: { c: 0 },
					prevDay: { o: 488.34, h: 488.44, l: 476.7, c: 480.99, v: 273618 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["CACI"], "pre");
		expect(quotes.get("CACI")).toBe("no_session_trade");
	});

	it("returns null for tickers Massive didn't include in the response (delisted / unknown)", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Distinguishes the no_session_trade case above from a true miss:
		// when Massive doesn't return a ticker entry at all, the map value
		// stays null so the renderer falls back to "price unavailable".
		vi.spyOn(globalThis, "fetch").mockResolvedValue(snapshotResponse([]));

		const quotes = await fetchSnapshotQuotes(["DELISTED"], "pre");
		expect(quotes.get("DELISTED")).toBeNull();
	});

	it("uses the latest after-hours minute bar instead of the locked 4:00 PM day.c", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// During after-hours `day.c` is the regular-session 4:00 PM close (locked
		// and stale to the user). `min.c` carries the latest extended-hours minute
		// bar, which is what the user expects to see in a 6 PM ET notification.
		// Without this, the displayed change-% (computed against today's regular
		// close) would always read 0.00% after hours.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "MSFT",
					todaysChangePerc: 1.0,
					updated: 1_778_530_000_000_000_000,
					day: { o: 396, h: 416, l: 395, c: 415.2, v: 25_000_000 },
					min: { c: 416.5 },
					prevDay: { o: 410, h: 412, l: 408, c: 411.2, v: 30_000_000 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["MSFT"], "after");
		const msft = expectQuote(quotes.get("MSFT"));
		expect(msft.price).toBe(416.5);
	});

	it("falls back to the locked 4:00 PM close when no after-hours trades have printed", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Illiquid name at 4:15 PM ET: no after-hours minute bar yet. We still
		// want to surface a price (the regular-session close) rather than null.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "SAIC",
					todaysChangePerc: 0.5,
					updated: 1_778_530_000_000_000_000,
					day: { o: 92, h: 94, l: 91, c: 93.93, v: 477144 },
					min: { c: 0 },
					prevDay: { o: 92.5, h: 93.5, l: 91.2, c: 93.46, v: 500000 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["SAIC"], "after");
		const saic = expectQuote(quotes.get("SAIC"));
		expect(saic.price).toBe(93.93);
		// Pin todaysChangePerc passthrough; the renderer's session-aware
		// change-% override is exercised in asset-formatting.test.ts.
		expect(saic.changePercent).toBeCloseTo(0.5, 2);
	});

	it("keeps using day.c during the regular session", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Regular session: day.c is the rolling close and is the authoritative
		// price even when a slightly-stale min bar disagrees. Guards against
		// regressions in the regular-hours path while fixing pre/after.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "SPY",
					todaysChangePerc: 0.5,
					updated: 1778500000000000000,
					day: { o: 497.5, h: 501.25, l: 497.0, c: 500.5, v: 50_000_000 },
					min: { c: 500.4 },
					prevDay: { o: 496.0, h: 499.0, l: 495.5, c: 498.0, v: 60_000_000 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["SPY"], "regular");
		const spy = expectQuote(quotes.get("SPY"));
		expect(spy.price).toBe(500.5);
		expect(spy.changePercent).toBeCloseTo(0.5, 2);
		expect(spy.dayOpen).toBe(497.5);
		expect(spy.dayHigh).toBe(501.25);
		expect(spy.dayLow).toBe(497.0);
	});

	it("uses day.c during a closed session so weekend SMS shows the last regular close", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		// Saturday/holiday: day.c is the last trading day's regular close (Friday).
		// Even if min.c happens to carry a stale extended-hours bar from Friday
		// night, the user expects to see the regular close, not an after-hours
		// flicker. Pairs with the "Market Closed — Prices below reflect the last
		// market close" banner in src/lib/messaging/market-closure-banner.ts.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "AAPL",
					todaysChangePerc: 0,
					updated: 1_778_300_000_000_000_000,
					day: { o: 178, h: 180, l: 177, c: 179.5, v: 50_000_000 },
					min: { c: 179.8 },
					prevDay: { o: 176, h: 178, l: 175, c: 177, v: 60_000_000 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["AAPL"], "closed");
		const aapl = expectQuote(quotes.get("AAPL"));
		expect(aapl.price).toBe(179.5);
		expect(aapl.prevClose).toBe(177);
		// todaysChangePerc=0 triggers the prev-day recalculation branch:
		// (179.5 - 177) / 177 * 100 ≈ +1.41%. Pins the math so an off-by-one
		// in the closed-session change-% derivation surfaces immediately.
		expect(aapl.changePercent).toBeCloseTo(1.41, 2);
	});
});
