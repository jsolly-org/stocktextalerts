import { describe, expect, it } from "vitest";
import { formatAssetEventsSection } from "../../src/lib/asset-events/format";

describe("formatAssetEventsSection", () => {
	it("formats earnings for SMS as compact one-liners", () => {
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
			},
			{
				symbol: "MSFT",
				event_type: "earnings" as const,
				event_date: "2026-02-12",
				data: { time: null, epsEstimate: null, revenueEstimate: null },
			},
		];

		const result = formatAssetEventsSection(events, "sms");

		expect(result.earnings).toContain("AAPL: earnings 02-10 (16:30)");
		expect(result.earnings).toContain("MSFT: earnings 02-12");
		expect(result.dividends).toBeNull();
		expect(result.splits).toBeNull();
	});

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
			},
		];

		const result = formatAssetEventsSection(events, "email");

		expect(result.earnings).toContain("AAPL: earnings 02-10 (16:30)");
		expect(result.earnings).toContain("EPS est. $2.35");
		expect(result.earnings).toContain("Rev est. $124.5B");
	});

	it("formats dividends for SMS", () => {
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
			},
		];

		const result = formatAssetEventsSection(events, "sms");

		expect(result.dividends).toContain("KO: ex-div 02-14 $0.50");
		expect(result.earnings).toBeNull();
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
			},
		];

		const result = formatAssetEventsSection(events, "email");

		expect(result.dividends).toContain("KO: ex-div 02-14 — $0.50/share (pays 04-01), quarterly");
	});

	it("formats forward splits", () => {
		const events = [
			{
				symbol: "NVDA",
				event_type: "split" as const,
				event_date: "2026-02-20",
				data: { splitFrom: 1, splitTo: 10, adjustmentType: "forward_split" },
			},
		];

		const sms = formatAssetEventsSection(events, "sms");
		const email = formatAssetEventsSection(events, "email");

		expect(sms.splits).toContain("NVDA: split 02-20 10:1");
		expect(email.splits).toContain("NVDA: split 02-20 — 10:1 forward split");
	});

	it("formats reverse splits", () => {
		const events = [
			{
				symbol: "SIRI",
				event_type: "split" as const,
				event_date: "2026-03-01",
				data: { splitFrom: 10, splitTo: 1, adjustmentType: "reverse_split" },
			},
		];

		const sms = formatAssetEventsSection(events, "sms");
		const email = formatAssetEventsSection(events, "email");

		expect(sms.splits).toContain("SIRI: split 03-01 10:1 reverse");
		expect(email.splits).toContain("SIRI: split 03-01 — 10:1 reverse split");
	});

	it("returns all nulls when no events", () => {
		const result = formatAssetEventsSection([], "email");

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
			},
			{
				symbol: "NVDA",
				event_type: "split" as const,
				event_date: "2026-02-20",
				data: { splitFrom: 1, splitTo: 10, adjustmentType: "forward_split" },
			},
		];

		const result = formatAssetEventsSection(events, "email");

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
			},
		];

		const result = formatAssetEventsSection(events, "email");

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

		const sms = formatAssetEventsSection(events, "sms");
		const email = formatAssetEventsSection(events, "email");

		expect(sms.earnings).toContain("AAPL: earnings today");
		expect(email.earnings).toContain("AAPL: earnings today");
	});

	it("shows 'tomorrow' when daysUntil is 1", () => {
		const events = [
			{
				symbol: "MSFT",
				event_type: "earnings" as const,
				event_date: "2026-02-13",
				data: { time: "16:00", epsEstimate: null, revenueEstimate: null },
				daysUntil: 1,
			},
		];

		const result = formatAssetEventsSection(events, "sms");

		expect(result.earnings).toContain("MSFT: earnings tomorrow");
	});

	it("shows 'in N days (MM-DD)' when daysUntil >= 2", () => {
		const events = [
			{
				symbol: "GOOGL",
				event_type: "earnings" as const,
				event_date: "2026-02-15",
				data: { time: null, epsEstimate: null, revenueEstimate: null },
				daysUntil: 3,
			},
		];

		const result = formatAssetEventsSection(events, "sms");

		expect(result.earnings).toContain("GOOGL: earnings in 3 days (02-15)");
	});

	it("falls back to MM-DD when daysUntil is undefined", () => {
		const events = [
			{
				symbol: "TSLA",
				event_type: "earnings" as const,
				event_date: "2026-02-18",
				data: { time: null, epsEstimate: null, revenueEstimate: null },
			},
		];

		const result = formatAssetEventsSection(events, "sms");

		expect(result.earnings).toContain("TSLA: earnings 02-18");
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
			},
		];

		const result = formatAssetEventsSection(events, "email");

		expect(result.dividends).toContain("JNJ: ex-div 02-15 — $1.19/share");
		expect(result.dividends).not.toContain("pays");
		expect(result.dividends).not.toContain("quarterly");
	});
});
