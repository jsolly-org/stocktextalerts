import { afterEach, describe, expect, it, vi } from "vitest";
import { polygonUpdatedNs } from "../../helpers/market-data";
import { fetchTopMovers } from "../../../src/lib/market-data/movers";

// Mock retry delays so error/retry paths don't wait real seconds.
vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function snapshotResponse(
	tickers: Array<{ ticker: string; close: number; changePercent: number }>,
) {
	return new Response(
		JSON.stringify({
			tickers: tickers.map((t) => ({
				ticker: t.ticker,
				todaysChangePerc: t.changePercent,
				updated: polygonUpdatedNs(1_775_862_308),
				day: { o: t.close, h: t.close, l: t.close, c: t.close, v: 1_000_000 },
				prevDay: { c: t.close / (1 + t.changePercent / 100) },
			})),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("fetchTopMovers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("filters out sub-$5 micro-caps from the gainers list", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{ ticker: "FUSE", close: 1.83, changePercent: 102.35 },
				{ ticker: "FUSEW", close: 0.09, changePercent: 74.6 },
				{ ticker: "SKYQ", close: 12.59, changePercent: 74.49 },
				{ ticker: "RAYA", close: 0.95, changePercent: 73.92 },
				{ ticker: "NVDA", close: 495.3, changePercent: 4.12 },
				{ ticker: "TSLA", close: 245.67, changePercent: 3.88 },
			]),
		);

		const gainers = await fetchTopMovers("gainers");

		expect(gainers.map((m) => m.ticker)).toEqual(["SKYQ", "NVDA", "TSLA"]);
		expect(gainers[0]).toMatchObject({
			ticker: "SKYQ",
			price: 12.59,
			changePercent: 74.49,
		});
	});

	it("respects a custom limit after filtering", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				{ ticker: "AAPL", close: 187.42, changePercent: 5.12 },
				{ ticker: "MSFT", close: 412.1, changePercent: 4.88 },
				{ ticker: "GOOG", close: 142.25, changePercent: 4.5 },
				{ ticker: "AMZN", close: 178.12, changePercent: 4.21 },
			]),
		);

		const gainers = await fetchTopMovers("gainers", { limit: 2 });

		expect(gainers).toHaveLength(2);
		expect(gainers.map((m) => m.ticker)).toEqual(["AAPL", "MSFT"]);
	});

	it("calls the losers endpoint when direction is losers", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				snapshotResponse([{ ticker: "BIIB", close: 212.45, changePercent: -18.67 }]),
			);

		const losers = await fetchTopMovers("losers");

		expect(losers[0]?.ticker).toBe("BIIB");
		const calledUrl = fetchSpy.mock.calls[0]?.[0]?.toString() ?? "";
		expect(calledUrl).toContain("/v2/snapshot/locale/us/markets/stocks/losers");
	});

	it("returns an empty array when the upstream call fails", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));

		const gainers = await fetchTopMovers("gainers");

		expect(gainers).toEqual([]);
	});

	it("skips tickers with zero todaysChangePerc so stale prev-day change isn't surfaced", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			snapshotResponse([
				// A genuine 0% entry: price equals prev close, hasn't moved today.
				{ ticker: "FLAT", close: 50.0, changePercent: 0 },
				{ ticker: "NVDA", close: 495.3, changePercent: 4.12 },
				{ ticker: "TSLA", close: 245.67, changePercent: 3.88 },
			]),
		);

		const gainers = await fetchTopMovers("gainers");

		expect(gainers.map((m) => m.ticker)).toEqual(["NVDA", "TSLA"]);
	});
});
