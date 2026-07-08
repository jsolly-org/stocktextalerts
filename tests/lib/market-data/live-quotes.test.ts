import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootLogger } from "../../../src/lib/logging";
import { fetchLiveQuotes } from "../../../src/lib/market-data/quotes";
import { NO_SESSION_TRADE } from "../../../src/lib/types";

// Make finnhubFetch's retry backoff and the rate limiter's waits instant.
const realDelayMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("node:timers/promises", () => ({ setTimeout: realDelayMock }));

// "Now" is Wed Jul 15 2026, 11:00 AM EDT (15:00 UTC) → today ET = 2026-07-15.
const NOW_UTC = Date.UTC(2026, 6, 15, 15, 0, 0);
const secs = (utcMs: number): number => Math.floor(utcMs / 1000);
const T_TODAY_AM = secs(Date.UTC(2026, 6, 15, 12, 0, 0)); // 8:00 AM EDT today
const T_TODAY_4PM = secs(Date.UTC(2026, 6, 15, 20, 0, 0)); // 4:00 PM EDT today
const T_YESTERDAY_4PM = secs(Date.UTC(2026, 6, 14, 20, 0, 0)); // 4:00 PM EDT yesterday
const T_LAST_FRIDAY = secs(Date.UTC(2026, 6, 10, 20, 0, 0)); // prior-week close

function quoteResponse(body: Record<string, number>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("fetchLiveQuotes — Finnhub /quote mapping and session semantics", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW_UTC));
		vi.stubEnv("FINNHUB_API_KEY", "test-finnhub-key");
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		realDelayMock.mockClear();
	});

	async function fetchOne(
		symbol: string,
		session: Parameters<typeof fetchLiveQuotes>[1],
		body: Record<string, number>,
	) {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(quoteResponse(body));
		const quotes = await fetchLiveQuotes([symbol], session);
		return quotes.get(symbol);
	}

	it("maps a regular-session quote and derives changePercent from pc, not the disagreeing dp", async () => {
		const quote = await fetchOne("AAPL", "regular", {
			c: 228.5,
			d: 5,
			dp: 99, // deliberately wrong — must be ignored in favor of the pc derivation
			h: 230,
			l: 225,
			o: 226,
			pc: 223.5,
			t: T_TODAY_AM,
		});
		expect(quote).toEqual({
			price: 228.5,
			changePercent: ((228.5 - 223.5) / 223.5) * 100,
			dayHigh: 230,
			dayLow: 225,
			dayOpen: 226,
			prevClose: 223.5,
			timestamp: T_TODAY_AM,
			volume: null,
		});
	});

	it("falls back to dp when pc is 0 (fresh IPO with no prior close)", async () => {
		const quote = await fetchOne("NEWIPO", "regular", { c: 50, dp: 3.2, pc: 0, t: T_TODAY_AM });
		expect(quote).toMatchObject({ price: 50, changePercent: 3.2, prevClose: null });
	});

	it("returns null when there is no price anchor (pc 0 and dp missing)", async () => {
		expect(await fetchOne("WEIRD", "regular", { c: 50, pc: 0, t: T_TODAY_AM })).toBeNull();
	});

	it("returns null for an unknown symbol (Finnhub c:0, t:0)", async () => {
		expect(
			await fetchOne("DELISTED", "regular", { c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 }),
		).toBeNull();
	});

	it("pre-market with a trade from this morning returns the live quote", async () => {
		const quote = await fetchOne("AAPL", "pre", { c: 100, pc: 99, t: T_TODAY_AM });
		expect(quote).toMatchObject({ price: 100 });
	});

	it("pre-market with a stale trade (yesterday) returns NO_SESSION_TRADE", async () => {
		expect(await fetchOne("BAH", "pre", { c: 100, pc: 99, t: T_YESTERDAY_4PM })).toBe(
			NO_SESSION_TRADE,
		);
	});

	it("after-hours with today's 4pm close returns the locked-close quote (not a sentinel)", async () => {
		const quote = await fetchOne("SAIC", "after", { c: 150, pc: 148, t: T_TODAY_4PM });
		expect(quote).toMatchObject({ price: 150 });
	});

	it("after-hours with a stale trade (yesterday) also returns NO_SESSION_TRADE", async () => {
		expect(await fetchOne("CACI", "after", { c: 150, pc: 148, t: T_YESTERDAY_4PM })).toBe(
			NO_SESSION_TRADE,
		);
	});

	it("a closed market never yields NO_SESSION_TRADE — the last close is the freshest data", async () => {
		const quote = await fetchOne("SPY", "closed", { c: 744.8, pc: 745.07, t: T_LAST_FRIDAY });
		expect(quote).toMatchObject({
			price: 744.8,
			changePercent: ((744.8 - 745.07) / 745.07) * 100,
		});
	});

	it("isolates a per-symbol fetch failure — the failed symbol is null, the rest resolve, no aggregate page", async () => {
		const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).includes("symbol=FAIL")) {
				return new Response("upstream error", { status: 500 });
			}
			return quoteResponse({ c: 200, pc: 198, t: T_TODAY_AM });
		});

		const quotes = await fetchLiveQuotes(["FAIL", "MSFT", "NVDA"], "regular");
		expect(quotes.get("FAIL")).toBeNull();
		expect(quotes.get("MSFT")).toMatchObject({ price: 200 });
		expect(quotes.get("NVDA")).toMatchObject({ price: 200 });
		// A partial outage must NOT fire the aggregate page — that's the whole point of the
		// `failures.length === symbols.length` guard (routine per-symbol flakiness stays warn-level).
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("an all-symbols outage logs a status-keyed breakdown (503 → api_error:503), proving upstream failure", async () => {
		const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("upstream error", { status: 503 }),
		);

		await fetchLiveQuotes(["TSLA", "AMD", "GOOG"], "regular");

		expect(errorSpy).toHaveBeenCalledWith(
			"Finnhub /quote failed for every symbol — live quotes unavailable",
			expect.objectContaining({
				action: "fetch_live_quotes",
				symbolCount: 3,
				failureBreakdown: { "api_error:503": 3 },
			}),
		);
	});

	it("an all-symbols rate-limit logs { rate_limited } — the free-tier throttle case, distinct from an outage", async () => {
		const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));

		await fetchLiveQuotes(["NFLX", "INTC"], "regular");

		expect(errorSpy).toHaveBeenCalledWith(
			"Finnhub /quote failed for every symbol — live quotes unavailable",
			expect.objectContaining({
				action: "fetch_live_quotes",
				symbolCount: 2,
				failureBreakdown: { rate_limited: 2 },
			}),
		);
	});

	it("a mixed all-symbols outage folds each reason into its own key (a 429 and 503s coexist)", async () => {
		const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
			String(input).includes("symbol=TSLA")
				? new Response("", { status: 429 })
				: new Response("upstream error", { status: 503 }),
		);

		await fetchLiveQuotes(["TSLA", "AMD", "GOOG"], "regular");

		expect(errorSpy).toHaveBeenCalledWith(
			"Finnhub /quote failed for every symbol — live quotes unavailable",
			expect.objectContaining({
				action: "fetch_live_quotes",
				symbolCount: 3,
				failureBreakdown: { rate_limited: 1, "api_error:503": 2 },
			}),
		);
	});
});
