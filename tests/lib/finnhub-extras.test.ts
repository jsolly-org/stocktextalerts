import { describe, expect, it } from "vitest";
import {
	buildNewsContextForGrok,
	type CompanyNewsItem,
	formatAnalystSection,
	formatInsiderSection,
	type InsiderTransaction,
	type RecommendationTrend,
} from "../../src/lib/providers/finnhub";

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
	it("Formats SMS analyst section as compact one-liners.", () => {
		const data = new Map<string, RecommendationTrend | null>([
			[
				"AAPL",
				{
					buy: 32,
					hold: 6,
					sell: 1,
					strongBuy: 10,
					strongSell: 0,
					period: "2026-02-01",
				},
			],
			["MSFT", null],
		]);

		const result = formatAnalystSection(data, "sms");

		expect(result).toBe("AAPL: 32 Buy, 6 Hold, 1 Sell");
	});

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

		const result = formatAnalystSection(data, "email");

		expect(result).toContain("15 Strong Buy");
		expect(result).toContain("38 Buy");
		expect(result).toContain("6 Hold");
		expect(result).toContain("2 Sell");
		expect(result).toContain("1 Strong Sell");
		expect(result).toContain("2026-01-01");
	});

	it("Returns null when all tickers have null data.", () => {
		const data = new Map<string, RecommendationTrend | null>([["AAPL", null]]);

		const result = formatAnalystSection(data, "sms");

		expect(result).toBeNull();
	});
});

describe("formatInsiderSection formats insider transactions per ticker.", () => {
	it("Formats SMS insider section with top 2 transactions per ticker.", () => {
		const transactions: InsiderTransaction[] = [
			{
				name: "Tim Cook",
				share: 100000,
				change: -50000,
				transactionType: "S",
				transactionDate: "2026-02-01",
			},
			{
				name: "Jeff Williams",
				share: 50000,
				change: 10000,
				transactionType: "P",
				transactionDate: "2026-01-28",
			},
			{
				name: "Luca Maestri",
				share: 30000,
				change: -5000,
				transactionType: "S",
				transactionDate: "2026-01-25",
			},
		];

		const data = new Map<string, InsiderTransaction[]>([
			["AAPL", transactions],
		]);

		const result = formatInsiderSection(data, "sms");

		expect(result).not.toBeNull();
		const lines = result?.split("\n");
		// SMS limits to 2 per ticker
		expect(lines?.length).toBe(2);
		expect(lines?.[0]).toContain("AAPL: Tim Cook sold 50k shares");
		expect(lines?.[1]).toContain("AAPL: Jeff Williams bought 10k shares");
	});

	it("Formats email insider section with more transactions.", () => {
		const transactions: InsiderTransaction[] = Array.from(
			{ length: 5 },
			(_, i) => ({
				name: `Insider ${i}`,
				share: 1000,
				change: i % 2 === 0 ? -1000 : 1000,
				transactionType: i % 2 === 0 ? "S" : "P",
				transactionDate: `2026-02-0${i + 1}`,
			}),
		);

		const data = new Map<string, InsiderTransaction[]>([
			["TSLA", transactions],
		]);

		const result = formatInsiderSection(data, "email");

		expect(result).not.toBeNull();
		const lines = result?.split("\n");
		// Email allows up to 5
		expect(lines?.length).toBe(5);
	});

	it("Returns 'no trades' message when no transactions exist but tickers are present.", () => {
		const data = new Map<string, InsiderTransaction[]>([["AAPL", []]]);

		const result = formatInsiderSection(data, "sms");

		expect(result).toBe("No reported insider trades in the last 24 hours.");
	});

	it("Returns null when the map is empty.", () => {
		const data = new Map<string, InsiderTransaction[]>();

		const result = formatInsiderSection(data, "sms");

		expect(result).toBeNull();
	});
});
