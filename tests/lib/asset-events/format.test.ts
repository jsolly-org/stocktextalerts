import { describe, expect, it } from "vitest";
import {
	formatAnalystSectionEmail,
	formatAssetEventsSectionEmail,
	formatInsiderSectionEmail,
} from "../../../src/lib/asset-events/format";
import type { InsiderTransaction, RecommendationTrend } from "../../../src/lib/types";

describe("formatAssetEventsSection", () => {
	it("formats earnings for email with estimates", () => {
		const events = [
			{
				symbol: "AAPL",
				event_type: "earnings" as const,
				event_date: "2026-02-10",
				data: {
					time: "16:30",
					epsEstimate: 2.35,
					revenueEstimate: 124_500_000_000,
				},
				daysUntil: 2,
			},
		];

		const result = formatAssetEventsSectionEmail(events);

		expect(result.earnings).toContain("AAPL: earnings in 2 days (02-10) (16:30)");
		expect(result.earnings).toContain("EPS est. $2.35");
		expect(result.earnings).toContain("Rev est. $124.5B");
	});

	it("formats dividends for email with pay date and frequency", () => {
		const events = [
			{
				symbol: "KO",
				event_type: "dividend" as const,
				event_date: "2026-02-14",
				data: {
					cashAmount: 0.5,
					currency: "USD",
					payDate: "2026-04-01",
					frequency: 4,
				},
				daysUntil: 2,
			},
		];

		const result = formatAssetEventsSectionEmail(events);

		expect(result.dividends).toContain(
			"KO: ex-div in 2 days (02-14) — $0.50/share (pays 04-01), quarterly",
		);
	});

	it("formats forward splits", () => {
		const events = [
			{
				symbol: "NVDA",
				event_type: "split" as const,
				event_date: "2026-02-20",
				data: { splitFrom: 1, splitTo: 10, adjustmentType: "forward_split" },
				daysUntil: 2,
			},
		];

		const email = formatAssetEventsSectionEmail(events);

		expect(email.splits).toContain("NVDA: split in 2 days (02-20) — 10:1 forward split");
	});

	it("formats reverse splits", () => {
		const events = [
			{
				symbol: "SIRI",
				event_type: "split" as const,
				event_date: "2026-03-01",
				data: { splitFrom: 10, splitTo: 1, adjustmentType: "reverse_split" },
				daysUntil: 2,
			},
		];

		const email = formatAssetEventsSectionEmail(events);

		expect(email.splits).toContain("SIRI: split in 2 days (03-01) — 10:1 reverse split");
	});

	it("returns all nulls when no events", () => {
		const result = formatAssetEventsSectionEmail([]);

		expect(result.earnings).toBeNull();
		expect(result.dividends).toBeNull();
		expect(result.splits).toBeNull();
	});

	it("groups multiple event types correctly", () => {
		const events = [
			{
				symbol: "AAPL",
				event_type: "earnings" as const,
				event_date: "2026-02-10",
				data: { time: null, epsEstimate: null, revenueEstimate: null },
				daysUntil: 2,
			},
			{
				symbol: "KO",
				event_type: "dividend" as const,
				event_date: "2026-02-14",
				data: {
					cashAmount: 0.5,
					currency: "USD",
					payDate: null,
					frequency: null,
				},
				daysUntil: 6,
			},
			{
				symbol: "NVDA",
				event_type: "split" as const,
				event_date: "2026-02-20",
				data: { splitFrom: 1, splitTo: 10, adjustmentType: "forward_split" },
				daysUntil: 12,
			},
		];

		const result = formatAssetEventsSectionEmail(events);

		expect(result.earnings).toContain("AAPL");
		expect(result.dividends).toContain("KO");
		expect(result.splits).toContain("NVDA");
	});

	it("handles revenue in millions", () => {
		const events = [
			{
				symbol: "SMALL",
				event_type: "earnings" as const,
				event_date: "2026-02-10",
				data: { time: null, epsEstimate: null, revenueEstimate: 7_500_000 },
				daysUntil: 2,
			},
		];

		const result = formatAssetEventsSectionEmail(events);

		expect(result.earnings).toContain("Rev est. $8M");
	});

	it("shows 'today' when daysUntil is 0", () => {
		const events = [
			{
				symbol: "AAPL",
				event_type: "earnings" as const,
				event_date: "2026-02-12",
				data: { time: null, epsEstimate: null, revenueEstimate: null },
				daysUntil: 0,
			},
		];

		const email = formatAssetEventsSectionEmail(events);

		expect(email.earnings).toContain("AAPL: earnings today");
	});

	it("handles dividend without pay date for email", () => {
		const events = [
			{
				symbol: "JNJ",
				event_type: "dividend" as const,
				event_date: "2026-02-15",
				data: {
					cashAmount: 1.19,
					currency: "USD",
					payDate: null,
					frequency: null,
				},
				daysUntil: 2,
			},
		];

		const result = formatAssetEventsSectionEmail(events);

		expect(result.dividends).toContain("JNJ: ex-div in 2 days (02-15) — $1.19/share");
		expect(result.dividends).not.toContain("pays");
		expect(result.dividends).not.toContain("quarterly");
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
		expect(lines?.length).toBe(5);
	});
});
