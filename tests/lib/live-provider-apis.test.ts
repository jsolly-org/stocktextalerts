import { describe, expect, it } from "vitest";
import { finnhubFetch } from "../../src/lib/providers/finnhub";
import {
	fetchSnapshotQuotes,
	marketDataFetch,
} from "../../src/lib/providers/massive";
import { fetchAssetPrices } from "../../src/lib/providers/price-fetcher";
import {
	assertLiveProviderKey,
	isLiveProviderEnabled,
} from "../helpers/live-api";

const describeMassiveLive = isLiveProviderEnabled("massive")
	? describe
	: describe.skip;
const describeFinnhubLive = isLiveProviderEnabled("finnhub")
	? describe
	: describe.skip;

describeMassiveLive("Massive live API (opt-in)", () => {
	assertLiveProviderKey({ provider: "massive", envVar: "MASSIVE_API_KEY" });

	it("returns a real SPIT price from the prev-close endpoint", async () => {
		const payload = await marketDataFetch(
			"/v2/aggs/ticker/SPIT/prev",
			{ adjusted: "true" },
			"live-spit-prev-close",
		);
		expect(payload).toBeTruthy();
		expect(typeof payload).toBe("object");

		const results = (payload as { results?: unknown }).results;
		expect(Array.isArray(results)).toBe(true);
		expect(results?.length ?? 0).toBeGreaterThan(0);

		const close = (results?.[0] as { c?: unknown } | undefined)?.c;
		expect(typeof close).toBe("number");
		expect((close as number) > 0).toBe(true);
	});

	it("returns at least one non-null quote from snapshot for liquid controls", async () => {
		const payload = await marketDataFetch(
			"/v2/snapshot/locale/us/markets/stocks/tickers",
			{ tickers: "SPY,AAPL" },
			"live-snapshot-controls",
		);
		expect(payload).toBeTruthy();
		expect(typeof payload).toBe("object");

		const tickers = (payload as { tickers?: unknown }).tickers;
		expect(Array.isArray(tickers)).toBe(true);

		const nonNullCount = (tickers as Array<{ day?: { c?: unknown } | null }>)
			.map((ticker) => ticker.day?.c)
			.filter(
				(value) =>
					typeof value === "number" && Number.isFinite(value) && value > 0,
			).length;

		expect(nonNullCount).toBeGreaterThan(0);
	});

	it("reproduces production behavior for SPIT (snapshot null) while prev-close is non-null", async () => {
		const productionSnapshot = await fetchSnapshotQuotes(["SPIT", "SPY"]);
		const spitQuote = productionSnapshot.get("SPIT");
		const spyQuote = productionSnapshot.get("SPY");

		// This parser path is what production scheduled updates/daily digest use.
		expect(spitQuote).toBeNull();
		expect(spyQuote).not.toBeNull();

		// Validate upstream snapshot payload shape that leads to the null.
		const rawSnapshot = await marketDataFetch(
			"/v2/snapshot/locale/us/markets/stocks/tickers",
			{ tickers: "SPIT" },
			"live-spit-snapshot-raw",
		);
		expect(rawSnapshot).toBeTruthy();
		const tickers = (rawSnapshot as { tickers?: unknown[] }).tickers;
		expect(Array.isArray(tickers)).toBe(true);
		expect((tickers?.length ?? 0) > 0).toBe(true);

		const spitRaw = tickers?.[0] as {
			day?: { c?: unknown };
			todaysChangePerc?: unknown;
			updated?: unknown;
		};
		expect(spitRaw.day?.c).toBe(0);
		expect(spitRaw.todaysChangePerc).toBe(0);
		expect(spitRaw.updated).toBe(0);

		const marketStatus = await marketDataFetch(
			"/v1/marketstatus/now",
			{},
			"live-market-status",
		);
		const market =
			typeof marketStatus === "object" && marketStatus !== null
				? (marketStatus as { market?: unknown }).market
				: null;

		// When market is closed, production pricing should backfill missing snapshot rows via prev-close.
		if (market === "closed") {
			const productionAssetPrices = await fetchAssetPrices(["SPIT", "SPY"]);
			expect(productionAssetPrices.get("SPIT")).not.toBeNull();
			expect(productionAssetPrices.get("SPY")).not.toBeNull();
		}

		// Massive still has a valid SPIT price via aggregate prev-close.
		const prevClose = await marketDataFetch(
			"/v2/aggs/ticker/SPIT/prev",
			{ adjusted: "true" },
			"live-spit-prev-close-verify",
		);
		const results = (prevClose as { results?: unknown[] }).results;
		const close = (results?.[0] as { c?: unknown } | undefined)?.c;
		expect(typeof close).toBe("number");
		expect((close as number) > 0).toBe(true);
	});
});

describeFinnhubLive("Finnhub live API (opt-in)", () => {
	assertLiveProviderKey({ provider: "finnhub", envVar: "FINNHUB_API_KEY" });

	it("returns an earnings calendar payload for current date range", async () => {
		const from = new Date().toISOString().slice(0, 10);
		const to = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);

		const payload = await finnhubFetch(
			"/calendar/earnings",
			{ from, to },
			"live-earnings-calendar",
		);
		expect(payload).toBeTruthy();
		expect(typeof payload).toBe("object");

		const events = (payload as { earningsCalendar?: unknown }).earningsCalendar;
		expect(Array.isArray(events)).toBe(true);
		expect((events as unknown[]).length).toBeGreaterThan(0);
	});
});
