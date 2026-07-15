import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootLogger } from "../../../src/lib/logging";
import { fetchSnapshotQuotes } from "../../../src/lib/market-data/quotes";
import { polygonUpdatedNs } from "../../helpers/market-data";
import { expectConsoleError } from "../../setup";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const NOW_UTC = Date.UTC(2026, 6, 15, 15, 0, 0);
const PRE_TODAY_MS = Date.UTC(2026, 6, 15, 12, 0, 0); // 8:00 AM ET
const REGULAR_TODAY_MS = Date.UTC(2026, 6, 15, 14, 0, 0); // 10:00 AM ET
const AFTER_TODAY_MS = Date.UTC(2026, 6, 15, 22, 0, 0); // 6:00 PM ET
const YESTERDAY_AFTER_MS = Date.UTC(2026, 6, 14, 22, 0, 0);

function snapshotResponse(tickers: unknown[]): Response {
	return new Response(JSON.stringify({ tickers }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function expectQuote<T>(entry: T | "no_session_trade" | null | undefined): T {
	expect(entry).not.toBeNull();
	expect(entry).not.toBe("no_session_trade");
	return entry as T;
}

function snapshotTicker(options: {
	ticker: string;
	dayClose: number;
	minuteClose: number;
	minuteTimestamp?: number;
	prevClose?: number;
}) {
	return {
		ticker: options.ticker,
		updated: polygonUpdatedNs(Math.floor(NOW_UTC / 1000)),
		day: {
			o: options.dayClose > 0 ? options.dayClose - 1 : 0,
			h: options.dayClose > 0 ? options.dayClose + 1 : 0,
			l: options.dayClose > 0 ? options.dayClose - 2 : 0,
			c: options.dayClose,
			v: options.dayClose > 0 ? 1_000 : 0,
		},
		min: {
			c: options.minuteClose,
			...(options.minuteTimestamp === undefined ? {} : { t: options.minuteTimestamp }),
		},
		prevDay: { c: options.prevClose ?? 100 },
	};
}

describe("fetchSnapshotQuotes session-aware price resolution", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW_UTC));
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses min.c in pre-market when min.t is in today's pre-market session", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "RTX",
					dayClose: 0,
					minuteClose: 175.77,
					minuteTimestamp: PRE_TODAY_MS,
					prevClose: 176.09,
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["RTX"], "pre")).get("RTX"));
		expect(quote.price).toBe(175.77);
		expect(quote.changePercent).toBeCloseTo(-0.18, 2);
		expect(quote.prevClose).toBe(176.09);
	});

	it("returns no_session_trade in pre-market when min.t is missing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "BAH",
					dayClose: 0,
					minuteClose: 101,
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["BAH"], "pre");
		expect(quotes.get("BAH")).toBe("no_session_trade");
	});

	it("does not attribute yesterday's minute bar to today's pre-market session", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "CACI",
					dayClose: 0,
					minuteClose: 101,
					minuteTimestamp: YESTERDAY_AFTER_MS,
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["CACI"], "pre");
		expect(quotes.get("CACI")).toBe("no_session_trade");
	});

	it("does not attribute a current-day regular minute bar to pre-market", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "GD",
					dayClose: 0,
					minuteClose: 101,
					minuteTimestamp: REGULAR_TODAY_MS,
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["GD"], "pre");
		expect(quotes.get("GD")).toBe("no_session_trade");
	});

	it("uses today's after-hours min.c instead of the locked day.c", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "MSFT",
					dayClose: 415.2,
					minuteClose: 416.5,
					minuteTimestamp: AFTER_TODAY_MS,
					prevClose: 411.2,
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["MSFT"], "after")).get("MSFT"));
		expect(quote.price).toBe(416.5);
		expect(quote.changePercent).toBeCloseTo(((416.5 - 411.2) / 411.2) * 100);
	});

	it("falls back to day.c after hours when min.t is stale", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "SAIC",
					dayClose: 93.93,
					minuteClose: 94.5,
					minuteTimestamp: YESTERDAY_AFTER_MS,
					prevClose: 93.46,
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["SAIC"], "after")).get("SAIC"));
		expect(quote.price).toBe(93.93);
		expect(quote.changePercent).toBeCloseTo(0.5, 2);
	});

	it("prefers day.c during the regular session", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "SPY",
					dayClose: 500.5,
					minuteClose: 500.4,
					minuteTimestamp: REGULAR_TODAY_MS,
					prevClose: 498,
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["SPY"], "regular")).get("SPY"));
		expect(quote.price).toBe(500.5);
		expect(quote.dayOpen).toBe(499.5);
		expect(quote.dayHigh).toBe(501.5);
		expect(quote.dayLow).toBe(498.5);
		expect(quote.volume).toBe(1_000);
	});

	it("falls back to min.c during regular hours when day.c is empty and min.t is regular", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "LATE",
					dayClose: 0,
					minuteClose: 52.5,
					minuteTimestamp: REGULAR_TODAY_MS,
					prevClose: 50,
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["LATE"], "regular")).get("LATE"));
		expect(quote.price).toBe(52.5);
	});

	it("does not treat a pre-market minute bar as the regular-session price", async () => {
		// Starter delay: clock can be regular while entitled min is still pre-market and day.c empty.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "OPENLAG",
					dayClose: 0,
					minuteClose: 101.5,
					minuteTimestamp: PRE_TODAY_MS,
					prevClose: 100,
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["OPENLAG"], "regular");
		expect(quotes.get("OPENLAG")).toBe("no_session_trade");
	});

	it("uses day.c after hours when min.t is a same-day regular bar", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "LOCK",
					dayClose: 200.1,
					minuteClose: 201.5,
					minuteTimestamp: REGULAR_TODAY_MS,
					prevClose: 198,
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["LOCK"], "after")).get("LOCK"));
		expect(quote.price).toBe(200.1);
	});

	it("rejects pre-market min.t exactly at the 9:30 ET open boundary", async () => {
		const openEtMs = Date.UTC(2026, 6, 15, 13, 30, 0); // 9:30 AM ET
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "EDGE",
					dayClose: 0,
					minuteClose: 50,
					minuteTimestamp: openEtMs,
					prevClose: 49,
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["EDGE"], "pre");
		expect(quotes.get("EDGE")).toBe("no_session_trade");
	});

	it("accepts after-hours min.t at the 4:00 PM ET close and rejects 8:00 PM ET", async () => {
		const closeEtMs = Date.UTC(2026, 6, 15, 20, 0, 0); // 4:00 PM ET
		const afterEndEtMs = Date.UTC(2026, 6, 16, 0, 0, 0); // 8:00 PM ET
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				snapshotResponse([
					snapshotTicker({
						ticker: "AHOK",
						dayClose: 10,
						minuteClose: 10.2,
						minuteTimestamp: closeEtMs,
						prevClose: 9.8,
					}),
				]),
			)
			.mockResolvedValueOnce(
				snapshotResponse([
					snapshotTicker({
						ticker: "AHEND",
						dayClose: 10,
						minuteClose: 10.3,
						minuteTimestamp: afterEndEtMs,
						prevClose: 9.8,
					}),
				]),
			);

		expect(expectQuote((await fetchSnapshotQuotes(["AHOK"], "after")).get("AHOK")).price).toBe(
			10.2,
		);
		// Stale/out-of-window min → fall back to locked day.c
		expect(expectQuote((await fetchSnapshotQuotes(["AHEND"], "after")).get("AHEND")).price).toBe(
			10,
		);
	});

	it("uses day.c and ignores stale min.c while closed", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "AAPL",
					dayClose: 179.5,
					minuteClose: 179.8,
					minuteTimestamp: YESTERDAY_AFTER_MS,
					prevClose: 177,
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["AAPL"], "closed")).get("AAPL"));
		expect(quote.price).toBe(179.5);
		expect(quote.changePercent).toBeCloseTo(1.41, 2);
	});

	it("keeps a missing response ticker as null rather than no_session_trade", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(snapshotResponse([]));

		const quotes = await fetchSnapshotQuotes(["DELISTED"], "pre");
		expect(quotes.get("DELISTED")).toBeNull();
	});

	it("derives change percent from the displayed price and prevDay.c", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					...snapshotTicker({
						ticker: "LDOS",
						dayClose: 122.24,
						minuteClose: 122.24,
						minuteTimestamp: REGULAR_TODAY_MS,
						prevClose: 121.69,
					}),
					todaysChangePerc: -0.06,
				},
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["LDOS"], "regular")).get("LDOS"));
		expect(quote.changePercent).toBeCloseTo(0.45, 2);
		expect(quote.changePercent).toBeGreaterThan(0);
	});

	it("returns null when prevDay.c cannot anchor change percent", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotTicker({
					ticker: "NEWIPO",
					dayClose: 25.8,
					minuteClose: 25.8,
					minuteTimestamp: REGULAR_TODAY_MS,
					prevClose: 0,
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["NEWIPO"], "regular");
		expect(quotes.get("NEWIPO")).toBeNull();
	});

	it("rejects non-finite price fields", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "BROKEN",
					day: { c: "NaN" },
					min: { c: null, t: PRE_TODAY_MS },
					prevDay: { c: 100 },
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["BROKEN"], "regular");
		expect(quotes.get("BROKEN")).toBe("no_session_trade");
	});

	it("splits lists above 250 symbols into multiple snapshot requests", async () => {
		// Fresh Response per call — concurrent chunks must not share one body stream.
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => snapshotResponse([]));
		const symbols = Array.from({ length: 251 }, (_, index) => `SYM${index}`);

		await fetchSnapshotQuotes(symbols, "regular");

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const urls = fetchSpy.mock.calls.map(([input]) => String(input));
		expect(urls.some((url) => url.includes("SYM0"))).toBe(true);
		expect(urls.some((url) => url.includes("SYM250"))).toBe(true);
	});

	it("keeps successful chunk quotes when another chunk fails", async () => {
		const symbols = ["AAA", ...Array.from({ length: 250 }, (_, index) => `SYM${index}`)];
		expectConsoleError("Massive snapshot-quotes exhausted retries");
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("AAA")) {
				return snapshotResponse([
					snapshotTicker({
						ticker: "AAA",
						dayClose: 10.5,
						minuteClose: 10.5,
						minuteTimestamp: REGULAR_TODAY_MS,
						prevClose: 10,
					}),
				]);
			}
			return new Response("gateway timeout", { status: 504 });
		});

		const quotes = await fetchSnapshotQuotes(symbols, "regular");

		expect(expectQuote(quotes.get("AAA")).price).toBe(10.5);
		expect(quotes.get("SYM249")).toBeNull();
	});

	it("does not log unexpected payload when the fetch already failed", async () => {
		expectConsoleError("Massive snapshot-quotes exhausted retries");
		const logError = vi.spyOn(rootLogger, "error");
		// Fresh Response per attempt — retries must not share one body stream.
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response("gateway timeout", { status: 504 }),
		);

		const quotes = await fetchSnapshotQuotes(["AAPL"], "regular");

		expect(quotes.get("AAPL")).toBeNull();
		const errorMessages = logError.mock.calls.map((call) => call[0]);
		expect(errorMessages).toContain("Massive snapshot-quotes exhausted retries");
		expect(errorMessages).not.toContain("Snapshot quote chunk returned unexpected payload shape");
	});

	it("logs unexpected payload shape for a non-null bad response body", async () => {
		expectConsoleError("Snapshot quote chunk returned unexpected payload shape");
		const logError = vi.spyOn(rootLogger, "error");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ tickers: "not-an-array" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const quotes = await fetchSnapshotQuotes(["AAPL"], "regular");

		expect(quotes.get("AAPL")).toBeNull();
		expect(logError.mock.calls.map((call) => call[0])).toContain(
			"Snapshot quote chunk returned unexpected payload shape",
		);
	});
});
