import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatAnalystSectionEmail,
	formatInsiderSectionEmail,
} from "../../../src/lib/asset-events/format";
import {
	buildNewsContextForGrok,
	fetchFinnhubExtras,
} from "../../../src/lib/daily-digest/finnhub-extras";
import type {
	CompanyNewsItem,
	InsiderTransaction,
	RecommendationTrend,
} from "../../../src/lib/types";
import {
	isOptionalVendorUnavailable,
	recordOptionalVendorFailure,
} from "../../../src/lib/vendors/optional-vendors";
import { resetOptionalVendorCircuits } from "../../helpers/reset-optional-vendor-circuits";

describe("buildNewsContextForGrok formats Finnhub headlines into a Grok context string.", () => {
	it("Builds context lines from multiple tickers with headlines.", () => {
		const newsData = new Map<string, CompanyNewsItem[]>([
			[
				"AAPL",
				[
					{
						headline: "Apple launches new MacBook",
						summary: "",
						datetime: 1,
						url: "https://example.com/apple-macbook",
						source: "TechCrunch",
					},
					{
						headline: "Apple revenue beats estimates",
						summary: "",
						datetime: 2,
						url: "https://example.com/apple-revenue",
						source: "Reuters",
					},
				],
			],
			[
				"MSFT",
				[
					{
						headline: "Microsoft expands AI offerings",
						summary: "",
						datetime: 3,
						url: "",
						source: "",
					},
				],
			],
		]);

		const context = buildNewsContextForGrok(newsData);

		expect(context).toContain(
			"AAPL: Apple launches new MacBook — https://example.com/apple-macbook",
		);
		expect(context).toContain(
			"AAPL: Apple revenue beats estimates — https://example.com/apple-revenue",
		);
		expect(context).toContain("MSFT: Microsoft expands AI offerings");
	});

	it("Does not append URL suffix when url is empty.", () => {
		const newsData = new Map<string, CompanyNewsItem[]>([
			[
				"GOOG",
				[
					{
						headline: "Google IO announced",
						summary: "",
						datetime: 4,
						url: "",
						source: "",
					},
				],
			],
		]);
		const context = buildNewsContextForGrok(newsData);
		expect(context).toBe("GOOG: Google IO announced");
	});

	it("Returns empty string when no news data is available.", () => {
		const newsData = new Map<string, CompanyNewsItem[]>([["AAPL", []]]);

		const context = buildNewsContextForGrok(newsData);

		expect(context).toBe("");
	});
});

describe("formatAnalystSection formats recommendation trends per ticker.", () => {
	it("Formats email analyst section with full breakdown.", () => {
		const data = new Map<string, RecommendationTrend | null>([
			[
				"NVDA",
				{
					buy: 38,
					hold: 6,
					sell: 2,
					strongBuy: 15,
					strongSell: 1,
					period: "2026-01-01",
				},
			],
		]);

		const result = formatAnalystSectionEmail(data);

		expect(result).toContain("15 Strong Buy");
		expect(result).toContain("38 Buy");
		expect(result).toContain("6 Hold");
		expect(result).toContain("2 Sell");
		expect(result).toContain("1 Strong Sell");
		expect(result).toContain("2026-01-01");
	});
});

describe("formatInsiderSection formats insider transactions per ticker.", () => {
	it("Formats email insider section with more transactions.", () => {
		const transactions: InsiderTransaction[] = Array.from({ length: 5 }, (_, i) => ({
			name: `Insider ${i}`,
			share: 1000,
			change: i % 2 === 0 ? -1000 : 1000,
			transactionType: i % 2 === 0 ? "S" : "P",
			transactionDate: `2026-02-0${i + 1}`,
		}));

		const data = new Map<string, InsiderTransaction[]>([["TSLA", transactions]]);

		const result = formatInsiderSectionEmail(data);

		expect(result).not.toBeNull();
		const lines = result?.split("\n");
		// Email allows up to 5
		expect(lines?.length).toBe(5);
	});
});

describe("fetchFinnhubExtras company-news degradation", () => {
	afterEach(() => {
		resetOptionalVendorCircuits();
		vi.restoreAllMocks();
	});

	it("stops fetching news when company-news circuit is open", async () => {
		vi.stubEnv("MASSIVE_API_KEY", "test-key");
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		recordOptionalVendorFailure("company-news");
		recordOptionalVendorFailure("company-news");
		expect(isOptionalVendorUnavailable("company-news")).toBe(true);

		const result = await fetchFinnhubExtras(["AAPL", "MSFT"], {
			includeNews: true,
			includeAnalyst: false,
			includeInsider: false,
		});

		expect(result.news.size).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
