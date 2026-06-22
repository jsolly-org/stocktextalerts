import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { finnhubFetch } from "../../src/lib/providers/finnhub";
import { fetchEarnings, resetEarningsCacheForTests } from "../../src/lib/providers/massive";

// Mock the network seam (massive.ts imports only finnhubFetch from this module);
// fetchEarnings' cache wraps the real parsing in massive.ts.
vi.mock("../../src/lib/providers/finnhub", () => ({ finnhubFetch: vi.fn() }));

const mockFinnhubFetch = finnhubFetch as unknown as Mock;

const WEEK_A = ["2026-06-22", "2026-06-26"] as const;
const WEEK_B = ["2026-06-29", "2026-07-03"] as const;

function calendar(symbol: string) {
	return {
		earningsCalendar: [
			{ symbol, date: "2026-06-23", hour: "amc", epsEstimate: 1.2, revenueEstimate: 1000 },
		],
	};
}

describe("fetchEarnings memoizes the market-wide earnings calendar per date range", () => {
	beforeEach(() => {
		resetEarningsCacheForTests();
		mockFinnhubFetch.mockReset();
	});
	afterEach(() => {
		resetEarningsCacheForTests();
	});

	it("collapses repeated same-range fetches into a single Finnhub call", async () => {
		mockFinnhubFetch.mockResolvedValue(calendar("AAPL"));

		const first = await fetchEarnings(WEEK_A[0], WEEK_A[1]);
		const second = await fetchEarnings(WEEK_A[0], WEEK_A[1]);

		expect(mockFinnhubFetch).toHaveBeenCalledTimes(1);
		expect(second).toBe(first); // same cached object, not a re-parse
		expect(first.failed).toBe(false);
		expect(first.data).toHaveLength(1);
		expect(first.data[0]?.ticker).toBe("AAPL");
	});

	it("re-fetches once the TTL elapses (does not serve stale data forever)", async () => {
		vi.useFakeTimers();
		try {
			mockFinnhubFetch.mockResolvedValue(calendar("TSLA"));

			await fetchEarnings(WEEK_A[0], WEEK_A[1]);
			expect(mockFinnhubFetch).toHaveBeenCalledTimes(1);

			// Still within the 5-min TTL — served from cache.
			vi.advanceTimersByTime(4 * 60_000);
			await fetchEarnings(WEEK_A[0], WEEK_A[1]);
			expect(mockFinnhubFetch).toHaveBeenCalledTimes(1);

			// Past the TTL — re-fetches.
			vi.advanceTimersByTime(2 * 60_000);
			await fetchEarnings(WEEK_A[0], WEEK_A[1]);
			expect(mockFinnhubFetch).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not cache a failed fetch — the next call retries instead of serving the failure", async () => {
		// finnhubFetch returns null when it exhausts retries (e.g. 429).
		mockFinnhubFetch.mockResolvedValueOnce(null).mockResolvedValueOnce(calendar("MSFT"));

		const failed = await fetchEarnings(WEEK_A[0], WEEK_A[1]);
		expect(failed.failed).toBe(true);

		const recovered = await fetchEarnings(WEEK_A[0], WEEK_A[1]);
		expect(recovered.failed).toBe(false);
		expect(recovered.data[0]?.ticker).toBe("MSFT");
		expect(mockFinnhubFetch).toHaveBeenCalledTimes(2);
	});

	it("keys the cache by date range — distinct weeks fetch independently", async () => {
		mockFinnhubFetch.mockResolvedValue(calendar("NVDA"));

		await fetchEarnings(WEEK_A[0], WEEK_A[1]);
		await fetchEarnings(WEEK_B[0], WEEK_B[1]);
		await fetchEarnings(WEEK_A[0], WEEK_A[1]); // still cached

		expect(mockFinnhubFetch).toHaveBeenCalledTimes(2);
	});
});
