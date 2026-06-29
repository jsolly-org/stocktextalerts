import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../src/lib/market-data/sparklines");

const fetchDailyClosesMock = vi.fn();
const getSevenDaySparklineFromCacheMock = vi.fn();

vi.mock("../../../src/lib/market-data/bars", () => ({
	fetchDailyCloses: (...args: unknown[]) => fetchDailyClosesMock(...args),
	fetchIntradayBars: vi.fn(),
}));

vi.mock("../../../src/lib/market-data/price-history-cache", async () => {
	const actual = await vi.importActual<
		typeof import("../../../src/lib/market-data/price-history-cache")
	>("../../../src/lib/market-data/price-history-cache");
	return {
		...actual,
		getSevenDaySparklineFromCache: (...args: unknown[]) =>
			getSevenDaySparklineFromCacheMock(...args),
		getIntradaySparklineFromCache: vi.fn(),
	};
});

type MarketDataSparklines = typeof import("../../../src/lib/market-data/sparklines");

describe("fetchSparklines cache-first", () => {
	let fetchSparklines: MarketDataSparklines["fetchSparklines"];
	const supabase = {} as never;

	beforeEach(async () => {
		vi.clearAllMocks();
		({ fetchSparklines } = await import("../../../src/lib/market-data/sparklines"));
	});

	it("returns cached sparklines without calling Massive when cache hits", async () => {
		const cached = {
			values: [1, 2, 3, 4, 5, 6, 7],
			ascii: "▁▂▃▄▅▆▇",
			window: "7-trading-days" as const,
		};
		getSevenDaySparklineFromCacheMock.mockResolvedValueOnce(cached);

		const result = await fetchSparklines(["AAPL"], { supabase });

		expect(result.get("AAPL")).toEqual(cached);
		expect(fetchDailyClosesMock).not.toHaveBeenCalled();
	});

	it("falls back to Massive only for symbols missing from cache", async () => {
		const cached = {
			values: [10, 11, 12, 13, 14, 15, 16],
			ascii: "▁▂▃▄▅▆▇",
			window: "7-trading-days" as const,
		};
		getSevenDaySparklineFromCacheMock.mockResolvedValueOnce(cached).mockResolvedValueOnce(null);
		fetchDailyClosesMock.mockResolvedValueOnce([100, 101, 102, 103, 104, 105, 106, 107]);

		const result = await fetchSparklines(["AAPL", "MSFT"], { supabase });

		expect(result.get("AAPL")).toEqual(cached);
		expect(result.get("MSFT")?.values).toEqual([101, 102, 103, 104, 105, 106, 107]);
		expect(fetchDailyClosesMock).toHaveBeenCalledTimes(1);
		expect(fetchDailyClosesMock).toHaveBeenCalledWith(
			"MSFT",
			expect.any(String),
			expect.any(String),
		);
	});

	it("calls Massive for every symbol when no cache options are provided", async () => {
		fetchDailyClosesMock.mockResolvedValueOnce([1, 2, 3, 4, 5, 6, 7, 8]);

		const result = await fetchSparklines(["AAPL"]);

		expect(result.get("AAPL")?.values).toEqual([2, 3, 4, 5, 6, 7, 8]);
		expect(getSevenDaySparklineFromCacheMock).not.toHaveBeenCalled();
		expect(fetchDailyClosesMock).toHaveBeenCalledTimes(1);
	});
});
