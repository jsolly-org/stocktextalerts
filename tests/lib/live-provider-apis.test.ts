import { describe, expect, it } from "vitest";
import { fetchCompanyNews } from "../../src/lib/providers/company-news";
import {
	fetchFinnhubExtras,
	finnhubFetch,
} from "../../src/lib/providers/finnhub";
import {
	fetchDailyCloses,
	fetchDividends,
	fetchIntradayBars,
	fetchIpos,
	fetchSnapshotQuotes,
	fetchSplits,
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

	it("returns daily closes for SPY over a recent date range (URL, API, parsing)", async () => {
		const to = new Date();
		const from = new Date(to);
		from.setDate(from.getDate() - 7);
		const fromStr = from.toISOString().slice(0, 10);
		const toStr = to.toISOString().slice(0, 10);

		const closes = await fetchDailyCloses("SPY", fromStr, toStr);

		expect(closes).not.toBeNull();
		expect(Array.isArray(closes)).toBe(true);
		expect((closes as number[]).length).toBeGreaterThan(0);
		for (const c of closes as number[]) {
			expect(typeof c).toBe("number");
			expect(Number.isFinite(c)).toBe(true);
		}
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
		expect((tickers as unknown[]).length).toBeGreaterThan(0);

		const nonNullCount = (tickers as Array<{ day?: { c?: unknown } | null }>)
			.map((ticker) => ticker.day?.c)
			.filter(
				(value) =>
					typeof value === "number" && Number.isFinite(value) && value > 0,
			).length;

		// On weekends/holidays day.c is 0 (no trades); only assert non-null when market is open.
		const marketStatus = await marketDataFetch(
			"/v1/marketstatus/now",
			{},
			"live-market-status-controls",
		);
		const market =
			typeof marketStatus === "object" && marketStatus !== null
				? (marketStatus as { market?: unknown }).market
				: null;

		if (market === "open" || market === "extended-hours") {
			expect(nonNullCount).toBeGreaterThan(0);
		}
	});

	it("returns IPO data from the /vX/reference/ipos endpoint", async () => {
		const from = new Date().toISOString().slice(0, 10);
		const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);

		const result = await fetchIpos(from, to);

		expect(result.failed).toBe(false);
		expect(Array.isArray(result.data)).toBe(true);
	});

	it("returns dividend data from the /v3/reference/dividends endpoint", async () => {
		const to = new Date();
		const from = new Date(to);
		from.setDate(from.getDate() - 30);
		const fromStr = from.toISOString().slice(0, 10);
		const toStr = to.toISOString().slice(0, 10);

		const result = await fetchDividends(fromStr, toStr);

		expect(result.failed).toBe(false);
		expect(Array.isArray(result.data)).toBe(true);
		expect(result.data.length).toBeGreaterThan(0);

		const first = result.data[0];
		expect(typeof first.ticker).toBe("string");
		expect(typeof first.exDividendDate).toBe("string");
		expect(typeof first.cashAmount).toBe("number");
	});

	it("returns splits data from the /v3/reference/splits endpoint", async () => {
		// Use a wide range to increase odds of finding splits
		const to = new Date();
		const from = new Date(to);
		from.setDate(from.getDate() - 90);
		const fromStr = from.toISOString().slice(0, 10);
		const toStr = to.toISOString().slice(0, 10);

		const result = await fetchSplits(fromStr, toStr);

		expect(result.failed).toBe(false);
		expect(Array.isArray(result.data)).toBe(true);
		// Splits are less frequent; just verify the endpoint doesn't error
	});

	it("returns intraday bars for SPY from the 5-minute aggregates endpoint", async () => {
		const result = await fetchIntradayBars("SPY");

		// Intraday bars may be null outside market hours on weekends
		if (result !== null) {
			expect(result.closes.length).toBeGreaterThan(0);
			for (const c of result.closes) {
				expect(typeof c).toBe("number");
				expect(Number.isFinite(c)).toBe(true);
			}
		}
	});

	it("returns upcoming market holidays from the /v1/marketstatus/upcoming endpoint", async () => {
		const payload = await marketDataFetch(
			"/v1/marketstatus/upcoming",
			{},
			"live-market-holidays",
		);

		expect(Array.isArray(payload)).toBe(true);
		expect((payload as unknown[]).length).toBeGreaterThan(0);

		const first = (payload as Record<string, unknown>[])[0];
		expect(typeof first.exchange).toBe("string");
		expect(typeof first.date).toBe("string");
		expect(typeof first.status).toBe("string");
	});

	it("returns company news from the /v2/reference/news endpoint", async () => {
		const to = new Date().toISOString().slice(0, 10);
		const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);

		const items = await fetchCompanyNews("AAPL", from, to);

		expect(Array.isArray(items)).toBe(true);
		expect(items.length).toBeGreaterThan(0);

		const first = items[0];
		expect(typeof first.headline).toBe("string");
		expect(typeof first.datetime).toBe("number");
	});

	it("handles SPIT snapshot correctly (null-snapshot vs valid-snapshot)", async () => {
		const productionSnapshot = await fetchSnapshotQuotes(["SPIT", "SPY"]);
		const spitQuote = productionSnapshot.get("SPIT");
		const spyQuote = productionSnapshot.get("SPY");

		const marketStatus = await marketDataFetch(
			"/v1/marketstatus/now",
			{},
			"live-market-status",
		);
		const market =
			typeof marketStatus === "object" && marketStatus !== null
				? (marketStatus as { market?: unknown }).market
				: null;

		// SPY should have a valid snapshot quote when the market is open.
		// On weekends/holidays, day.c is 0 so parseSnapshotTicker returns null.
		if (market === "open" || market === "extended-hours") {
			expect(spyQuote).not.toBeNull();
		}

		// SPIT may have a null or valid snapshot depending on current market data.
		// When null: the parser correctly filters zero-valued snapshots.
		// When valid: the ticker now has real trading activity.
		if (spitQuote === null) {
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
		} else {
			// SPIT now has valid trading data; verify the quote is well-formed.
			expect(spitQuote.price).toBeGreaterThan(0);
		}

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

	it("returns analyst recommendations for a liquid ticker", async () => {
		const result = await fetchFinnhubExtras(["AAPL"], {
			includeNews: false,
			includeAnalyst: true,
			includeInsider: false,
		});

		const analystData = result.analyst.get("AAPL");
		expect(analystData).not.toBeNull();
		expect(typeof analystData?.buy).toBe("number");
		expect(typeof analystData?.hold).toBe("number");
		expect(typeof analystData?.sell).toBe("number");
		expect(typeof analystData?.period).toBe("string");
	});

	it("returns insider transactions without error", async () => {
		const result = await fetchFinnhubExtras(["AAPL"], {
			includeNews: false,
			includeAnalyst: false,
			includeInsider: true,
		});

		const insiderData = result.insider.get("AAPL");
		expect(Array.isArray(insiderData)).toBe(true);
		// Insider transactions may be empty for recent 24h window; just verify no error
	});

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
