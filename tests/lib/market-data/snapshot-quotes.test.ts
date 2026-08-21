import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootLogger } from "../../../src/lib/logging";
import { fetchSnapshotQuotes } from "../../../src/lib/market-data/quotes";
import { polygonUpdatedNs } from "../../helpers/market-data";
import { expectConsoleError } from "../../setup";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const NOW_UTC = Date.UTC(2026, 6, 15, 15, 0, 0);

function snapshotResponse(results: unknown[]): Response {
	return new Response(JSON.stringify({ status: "OK", results }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function expectQuote<T>(entry: T | "no_session_trade" | null | undefined): T {
	expect(entry).not.toBeNull();
	expect(entry).not.toBe("no_session_trade");
	return entry as T;
}

function snapshotResult(options: {
	ticker: string;
	dayClose: number;
	minuteClose: number;
	prevClose?: number;
	marketStatus?: "open" | "closed" | "early_trading" | "late_trading";
}) {
	const dayClose = options.dayClose;
	return {
		ticker: options.ticker,
		type: "stocks",
		market_status: options.marketStatus ?? "open",
		session: {
			open: dayClose > 0 ? dayClose - 1 : 0,
			high: dayClose > 0 ? dayClose + 1 : 0,
			low: dayClose > 0 ? dayClose - 2 : 0,
			close: dayClose,
			volume: dayClose > 0 ? 1_000 : 0,
			previous_close: options.prevClose ?? 100,
			last_updated: polygonUpdatedNs(Math.floor(NOW_UTC / 1000)),
		},
		last_minute: {
			close: options.minuteClose,
			// Refresh clock — intentionally not used for session gating.
			last_updated: polygonUpdatedNs(Math.floor(NOW_UTC / 1000)),
		},
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

	it("uses last_minute.close in pre-market when market_status is early_trading", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "RTX",
					dayClose: 0,
					minuteClose: 175.77,
					prevClose: 176.09,
					marketStatus: "early_trading",
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["RTX"], "pre")).get("RTX"));
		expect(quote.price).toBe(175.77);
		expect(quote.changePercent).toBeCloseTo(-0.18, 2);
		expect(quote.prevClose).toBe(176.09);
		expect(quote.timestamp).toBe(Math.floor(NOW_UTC / 1000));
	});

	it("returns no_session_trade in pre-market when market_status is not early_trading", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "BAH",
					dayClose: 0,
					minuteClose: 101,
					marketStatus: "closed",
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["BAH"], "pre");
		expect(quotes.get("BAH")).toBe("no_session_trade");
	});

	it("does not attribute a regular-session print to pre-market", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "GD",
					dayClose: 0,
					minuteClose: 101,
					marketStatus: "open",
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["GD"], "pre");
		expect(quotes.get("GD")).toBe("no_session_trade");
	});

	it("uses last_minute.close after hours when market_status is late_trading", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "MSFT",
					dayClose: 415.2,
					minuteClose: 416.5,
					prevClose: 411.2,
					marketStatus: "late_trading",
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["MSFT"], "after")).get("MSFT"));
		expect(quote.price).toBe(416.5);
		expect(quote.changePercent).toBeCloseTo(((416.5 - 411.2) / 411.2) * 100);
	});

	it("falls back to session.close after hours when market_status is still open (delayed)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "SAIC",
					dayClose: 93.93,
					minuteClose: 94.5,
					prevClose: 93.46,
					marketStatus: "open",
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["SAIC"], "after")).get("SAIC"));
		expect(quote.price).toBe(93.93);
		expect(quote.changePercent).toBeCloseTo(0.5, 2);
	});

	it("prefers session.close during the regular session", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "SPY",
					dayClose: 500.5,
					minuteClose: 500.4,
					prevClose: 498,
					marketStatus: "open",
				}),
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["SPY"], "regular")).get("SPY"));
		expect(quote.price).toBe(500.5);
		expect(quote.dayOpen).toBe(499.5);
		expect(quote.dayHigh).toBe(501.5);
		expect(quote.dayLow).toBe(498.5);
		expect(quote.volume).toBe(1_000);
		expect(quote.timestamp).toBe(Math.floor(NOW_UTC / 1000));
	});

	it("returns no_session_trade in regular when close equals previous_close with empty open and volume", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "MOD",
					type: "stocks",
					market_status: "open",
					session: {
						open: 0,
						high: 0,
						low: 0,
						close: 100,
						volume: 0,
						previous_close: 100,
						last_updated: polygonUpdatedNs(Math.floor(NOW_UTC / 1000)),
					},
					last_minute: {
						close: 107.76,
						last_updated: polygonUpdatedNs(Math.floor(NOW_UTC / 1000)),
					},
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["MOD"], "regular");
		expect(quotes.get("MOD")).toBe("no_session_trade");
	});

	it("does not fall back to last_minute during regular hours when session.close is empty", async () => {
		// Starter delay: market_status can already be open while session.close is empty and
		// last_minute.close is still a pre-market print. last_updated is a refresh clock
		// (~15m ahead of entitled data), so it must not unlock that fallback.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "OPENLAG",
					dayClose: 0,
					minuteClose: 101.5,
					prevClose: 100,
					marketStatus: "open",
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["OPENLAG"], "regular");
		expect(quotes.get("OPENLAG")).toBe("no_session_trade");
	});

	it("does not treat early_trading last_minute as the regular-session price", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "PRELAG",
					dayClose: 0,
					minuteClose: 101.5,
					prevClose: 100,
					marketStatus: "early_trading",
				}),
			]),
		);

		const quotes = await fetchSnapshotQuotes(["PRELAG"], "regular");
		expect(quotes.get("PRELAG")).toBe("no_session_trade");
	});

	it("uses session.close and ignores last_minute while closed", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "AAPL",
					dayClose: 179.5,
					minuteClose: 179.8,
					prevClose: 177,
					marketStatus: "closed",
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

	it("treats per-ticker NOT_FOUND as a miss (null), not no_session_trade", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					ticker: "GONE",
					error: "NOT_FOUND",
					message: "Ticker not found.",
				},
			]),
		);

		const quotes = await fetchSnapshotQuotes(["GONE"], "regular");
		expect(quotes.get("GONE")).toBeNull();
	});

	it("derives change percent from the displayed price and session.previous_close", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{
					...snapshotResult({
						ticker: "LDOS",
						dayClose: 122.24,
						minuteClose: 122.24,
						prevClose: 121.69,
						marketStatus: "open",
					}),
					session: {
						...snapshotResult({
							ticker: "LDOS",
							dayClose: 122.24,
							minuteClose: 122.24,
							prevClose: 121.69,
						}).session,
						change_percent: -0.06,
					},
				},
			]),
		);

		const quote = expectQuote((await fetchSnapshotQuotes(["LDOS"], "regular")).get("LDOS"));
		expect(quote.changePercent).toBeCloseTo(0.45, 2);
		expect(quote.changePercent).toBeGreaterThan(0);
	});

	it("returns null when previous_close cannot anchor change percent", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				snapshotResult({
					ticker: "NEWIPO",
					dayClose: 25.8,
					minuteClose: 25.8,
					prevClose: 0,
					marketStatus: "open",
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
					market_status: "open",
					session: { close: "NaN", previous_close: 100 },
					last_minute: { close: null },
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
		expect(urls.every((url) => url.includes("/v3/snapshot?"))).toBe(true);
		expect(urls.every((url) => url.includes("ticker.any_of="))).toBe(true);
		expect(urls.some((url) => /(?:^|[?&])limit=250(?:&|$)/.test(url))).toBe(true);
		expect(urls.some((url) => /(?:^|[?&])limit=1(?:&|$)/.test(url))).toBe(true);
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
					snapshotResult({
						ticker: "AAA",
						dayClose: 10.5,
						minuteClose: 10.5,
						prevClose: 10,
						marketStatus: "open",
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
			new Response(JSON.stringify({ results: "not-an-array" }), {
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
