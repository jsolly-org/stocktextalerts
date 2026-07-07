/**
 * Fetch-level tests for `fetchActiveTickers` — stubs `globalThis.fetch` (like
 * tests/lib/company-news/fetch.test.ts) so the Finnhub `/stock/symbol` parsing,
 * filtering, and failure semantics are exercised without network or vi.mock.
 * FINNHUB_API_KEY comes from the tests/setup.ts env baseline.
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { fetchActiveTickers } from "../../../../src/lib/assets/reference/universe";
import { VENDOR_FETCH_MAX_RETRIES } from "../../../../src/lib/vendors/constants";
import { errorMessages, expectConsoleError } from "../../../setup";

// Mock retry delays so transport-failure tests don't wait real seconds.
vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

/** Build a Finnhub /stock/symbol JSON response (Finnhub returns a bare array). */
function finnhubResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** One realistic Finnhub /stock/symbol row. */
function symbolRow(overrides: {
	symbol: string;
	description: string;
	type: string;
	mic?: string;
}): Record<string, unknown> {
	return {
		currency: "USD",
		description: overrides.description,
		displaySymbol: overrides.symbol,
		figi: "BBG000000000",
		mic: overrides.mic ?? "XNAS",
		symbol: overrides.symbol,
		type: overrides.type,
	};
}

// Real ETF marketing names routinely blow past our varchar(255) name column.
const LONG_ETF_NAME =
	"GLOBAL X FUNDS - GLOBAL X S&P 500 COVERED CALL AND GROWTH ETF OF BENEFICIAL INTEREST REPRESENTING AN UNDIVIDED PROPORTIONATE SHARE IN THE ASSETS AND LIABILITIES OF THE SERIES ISSUED UNDER THE SECOND AMENDED AND RESTATED DECLARATION OF TRUST DATED FEBRUARY 2018";

describe("fetchActiveTickers", () => {
	let fetchSpy: MockInstance<typeof fetch>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("A full US listing splits into the typed stock/etf subset while the superset keeps every active symbol", async () => {
		expect(LONG_ETF_NAME.length).toBeGreaterThan(255);
		fetchSpy.mockResolvedValue(
			finnhubResponse([
				symbolRow({ symbol: "AAPL", description: "APPLE INC", type: "Common Stock" }),
				// Duplicate listing on another venue — deduped from the typed subset.
				symbolRow({
					symbol: "AAPL",
					description: "APPLE INC",
					type: "Common Stock",
					mic: "BATS",
				}),
				symbolRow({
					symbol: "TSM",
					description: "TAIWAN SEMICONDUCTOR MANUFACTURING - ADR",
					type: "ADR",
				}),
				symbolRow({ symbol: "O", description: "REALTY INCOME CORP", type: "REIT" }),
				symbolRow({ symbol: "XYLG", description: LONG_ETF_NAME, type: "ETP" }),
				// Dotted share class: superset-only.
				symbolRow({
					symbol: "BRK.B",
					description: "BERKSHIRE HATHAWAY INC-CL B",
					type: "Common Stock",
				}),
				// Unmapped security type: superset-only.
				symbolRow({
					symbol: "OXY+",
					description: "OCCIDENTAL PETROLEUM CORP WARRANT",
					type: "Warrant",
				}),
				// Empty description: superset-only.
				symbolRow({ symbol: "NVAX2", description: "", type: "Common Stock" }),
				// 11-char corporate-action symbol (over the varchar(10) column): superset-only.
				symbolRow({
					symbol: "CIONA251230",
					description: "CION INVESTMENT CORP 7.5% NOTES",
					type: "Common Stock",
				}),
			]),
		);

		const universe = await fetchActiveTickers();

		const fetchedUrl = String(fetchSpy.mock.calls[0]?.[0]);
		expect(fetchedUrl).toBe(
			"https://finnhub.io/api/v1/stock/symbol?exchange=US&token=test-finnhub-key",
		);

		expect(universe.tickers.map((t) => t.symbol)).toEqual(["AAPL", "TSM", "O", "XYLG"]);
		expect(universe.tickers.map((t) => t.type)).toEqual(["stock", "stock", "stock", "etf"]);
		// Over-long vendor names are truncated to the varchar(255) column.
		const etf = universe.tickers.find((t) => t.symbol === "XYLG");
		expect(etf?.name).toBe(LONG_ETF_NAME.slice(0, 255));

		// EVERY active symbol lands in the superset — including the rows the typed
		// subset skipped — so delist-absence checks can't misread a type quirk.
		expect(universe.allActiveSymbols).toEqual(
			new Set(["AAPL", "TSM", "O", "XYLG", "BRK.B", "OXY+", "NVAX2", "CIONA251230"]),
		);
	});

	it("A non-array payload (Finnhub error body) yields an empty universe and logs the shape drift at error", async () => {
		fetchSpy.mockImplementation(async () =>
			finnhubResponse({ error: "You don't have access to this resource." }),
		);
		expectConsoleError(/payload was not an array/);

		const universe = await fetchActiveTickers();

		expect(universe.tickers).toEqual([]);
		expect(universe.allActiveSymbols.size).toBe(0);
		expect(errorMessages()).toContainEqual(expect.stringContaining("payload was not an array"));
	});

	it("A Finnhub outage (HTTP 500 across all retries) yields an empty universe without the shape-drift log", async () => {
		fetchSpy.mockImplementation(async () =>
			finnhubResponse({ error: "Internal server error" }, 500),
		);
		// Retry exhaustion on a required vendor logs at error — expected here.
		expectConsoleError(/exhausted retries/);

		const universe = await fetchActiveTickers();

		expect(fetchSpy).toHaveBeenCalledTimes(VENDOR_FETCH_MAX_RETRIES);
		expect(universe.tickers).toEqual([]);
		expect(universe.allActiveSymbols.size).toBe(0);
		// Transport failure is finnhubFetch returning null — NOT payload drift.
		expect(errorMessages()).not.toContainEqual(expect.stringContaining("payload was not an array"));
	});
});
