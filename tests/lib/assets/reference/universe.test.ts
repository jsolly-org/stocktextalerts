/**
 * Fetch-level tests for Massive's paginated active ticker universe. The global
 * fetch stub exercises URL construction, type pagination, parsing, and failure
 * semantics without live provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ACTIVE_TICKER_TYPES } from "../../../../src/lib/assets/reference/constants";
import { fetchActiveTickers } from "../../../../src/lib/assets/reference/universe";
import { VENDOR_FETCH_MAX_RETRIES } from "../../../../src/lib/vendors/constants";
import { expectConsoleError } from "../../../setup";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function massiveResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function tickerRow(
	ticker: string,
	name?: string,
	lastUpdatedUtc?: string,
): Record<string, unknown> {
	return {
		ticker,
		...(name === undefined ? {} : { name }),
		...(lastUpdatedUtc === undefined ? {} : { last_updated_utc: lastUpdatedUtc }),
		active: true,
		market: "stocks",
	};
}

const LONG_ETF_NAME = `Global X ${"Covered Call and Growth ".repeat(14)}ETF`;

describe("fetchActiveTickers", () => {
	let fetchSpy: MockInstance<typeof fetch>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("paginates every Massive type, preserves proper-case names, and keeps all valid symbols in the safety superset", async () => {
		expect(LONG_ETF_NAME.length).toBeGreaterThan(255);
		fetchSpy.mockImplementation(async (input) => {
			const url = new URL(String(input));
			const type = url.searchParams.get("type");
			const cursor = url.searchParams.get("cursor");

			if (type === "CS" && cursor === null) {
				return massiveResponse({
					results: [tickerRow("aapl", "Apple Inc.", "2026-06-15T00:00:00Z")],
					next_url:
						"https://api.massive.com/v3/reference/tickers?type=CS&cursor=next-cs&apiKey=provider-key",
				});
			}
			if (type === "CS" && cursor === "next-cs") {
				return massiveResponse({
					results: [
						tickerRow("BRK.B", "Berkshire Hathaway Inc."),
						tickerRow("NVAX2"),
						tickerRow("CIONA251230", "CION Investment Corp Notes"),
						tickerRow("BAD SYMBOL", "Malformed Symbol Corp"),
					],
				});
			}
			if (type === "ADRC") {
				return massiveResponse({
					results: [tickerRow("TSM", "Taiwan Semiconductor Manufacturing Co. Ltd.")],
				});
			}
			if (type === "OS") {
				return massiveResponse({
					// Cross-type duplicate: first normalized occurrence wins.
					results: [tickerRow("AAPL", "Apple Incorporated")],
				});
			}
			if (type === "ETF") {
				return massiveResponse({ results: [tickerRow("XYLG", LONG_ETF_NAME)] });
			}
			return massiveResponse({ results: [] });
		});

		const universe = await fetchActiveTickers();

		expect(universe.tickers.map((ticker) => ticker.symbol)).toEqual(["AAPL", "TSM", "XYLG"]);
		expect(universe.tickers.map((ticker) => ticker.type)).toEqual(["stock", "stock", "etf"]);
		expect(universe.tickers[0]?.name).toBe("Apple Inc.");
		expect(universe.tickers[0]?.lastUpdatedUtc).toBe("2026-06-15T00:00:00Z");
		expect(universe.tickers[1]?.lastUpdatedUtc).toBeNull();
		expect(universe.tickers[2]?.name).toBe(LONG_ETF_NAME.slice(0, 255));
		expect(universe.allActiveSymbols).toEqual(
			new Set(["AAPL", "BRK.B", "NVAX2", "CIONA251230", "BAD SYMBOL", "TSM", "XYLG"]),
		);

		const requestedTypes = fetchSpy.mock.calls.map(([input]) => {
			const url = new URL(String(input));
			expect(url.origin).toBe("https://api.massive.com");
			expect(url.pathname).toBe("/v3/reference/tickers");
			expect(url.searchParams.get("apiKey")).toBe("test-massive-key");
			return url.searchParams.get("type");
		});
		expect(new Set(requestedTypes)).toEqual(
			new Set(ACTIVE_TICKER_TYPES.map(({ apiType }) => apiType)),
		);
	});

	it("returns an empty universe when a type's first page fails completely", async () => {
		expectConsoleError(/exhausted retries/);
		fetchSpy.mockResolvedValue(massiveResponse({ status: "ERROR" }, 500));

		const universe = await fetchActiveTickers();

		expect(fetchSpy).toHaveBeenCalledTimes(VENDOR_FETCH_MAX_RETRIES);
		expect(universe.tickers).toEqual([]);
		expect(universe.allActiveSymbols.size).toBe(0);
	});

	it("throws when a later page fails so reconcile cannot consume a truncated universe", async () => {
		expectConsoleError(/exhausted retries/);
		fetchSpy
			.mockResolvedValueOnce(
				massiveResponse({
					results: [tickerRow("AAPL", "Apple Inc.")],
					next_url: "https://api.massive.com/v3/reference/tickers?type=CS&cursor=next-cs",
				}),
			)
			.mockResolvedValue(massiveResponse({ status: "ERROR" }, 500));

		await expect(fetchActiveTickers()).rejects.toThrow("no data mid-pagination");
		expect(fetchSpy).toHaveBeenCalledTimes(1 + VENDOR_FETCH_MAX_RETRIES);
	});

	it("rejects an untrusted pagination URL", async () => {
		fetchSpy.mockResolvedValue(
			massiveResponse({
				results: [tickerRow("AAPL", "Apple Inc.")],
				next_url: "https://attacker.example/v3/reference/tickers?cursor=stolen",
			}),
		);

		await expect(fetchActiveTickers()).rejects.toThrow("host must be api.massive.com");
	});

	it("returns an empty universe when a first-page results shape drifts", async () => {
		expectConsoleError(/missing results/);
		fetchSpy.mockResolvedValue(massiveResponse({ results: { ticker: "AAPL" } }));

		const universe = await fetchActiveTickers();

		expect(universe.tickers).toEqual([]);
		expect(universe.allActiveSymbols.size).toBe(0);
	});
});
