import { describe, expect, it } from "vitest";
import {
	type DividendEvent,
	type EarningsEvent,
	formatDividendsSection,
	formatEarningsSection,
} from "../../src/lib/finnhub-extras";

describe("formatEarningsSection formats earnings events per ticker.", () => {
	it("Formats SMS earnings section as compact one-liners.", () => {
		const data = new Map<string, EarningsEvent[]>([
			[
				"AAPL",
				[
					{
						symbol: "AAPL",
						date: "2026-02-10",
						hour: "amc",
						epsEstimate: 2.35,
						revenueEstimate: 124_500_000_000,
					},
				],
			],
			[
				"MSFT",
				[
					{
						symbol: "MSFT",
						date: "2026-02-12",
						hour: "bmo",
						epsEstimate: 3.1,
						revenueEstimate: 65_000_000_000,
					},
				],
			],
		]);

		const result = formatEarningsSection(data, "sms");

		expect(result).not.toBeNull();
		expect(result).toContain("AAPL: 02-10 (after close)");
		expect(result).toContain("MSFT: 02-12 (before open)");
	});

	it("Formats email earnings section with estimate details.", () => {
		const data = new Map<string, EarningsEvent[]>([
			[
				"AAPL",
				[
					{
						symbol: "AAPL",
						date: "2026-02-10",
						hour: "amc",
						epsEstimate: 2.35,
						revenueEstimate: 124_500_000_000,
					},
				],
			],
		]);

		const result = formatEarningsSection(data, "email");

		expect(result).not.toBeNull();
		expect(result).toContain("AAPL: 02-10 (after close)");
		expect(result).toContain("EPS est. $2.35");
		expect(result).toContain("Rev est. $124.5B");
	});

	it("Returns null when no earnings events exist.", () => {
		const data = new Map<string, EarningsEvent[]>([["AAPL", []]]);

		const result = formatEarningsSection(data, "sms");

		expect(result).toBeNull();
	});

	it("Handles dmh hour label.", () => {
		const data = new Map<string, EarningsEvent[]>([
			[
				"TSLA",
				[
					{
						symbol: "TSLA",
						date: "2026-02-11",
						hour: "dmh",
						epsEstimate: null,
						revenueEstimate: null,
					},
				],
			],
		]);

		const result = formatEarningsSection(data, "sms");

		expect(result).toContain("TSLA: 02-11 (during market hours)");
	});

	it("Handles null estimates in email format.", () => {
		const data = new Map<string, EarningsEvent[]>([
			[
				"GOOG",
				[
					{
						symbol: "GOOG",
						date: "2026-02-13",
						hour: "amc",
						epsEstimate: null,
						revenueEstimate: null,
					},
				],
			],
		]);

		const result = formatEarningsSection(data, "email");

		expect(result).not.toBeNull();
		expect(result).toContain("GOOG: 02-13 (after close)");
		expect(result).not.toContain("EPS est.");
		expect(result).not.toContain("Rev est.");
	});
});

describe("formatDividendsSection formats dividend events per ticker.", () => {
	it("Formats SMS dividend section as compact one-liners.", () => {
		const data = new Map<string, DividendEvent[]>([
			[
				"AAPL",
				[
					{
						symbol: "AAPL",
						exDate: "2026-02-11",
						payDate: "2026-02-18",
						amount: 0.24,
						currency: "USD",
					},
				],
			],
		]);

		const result = formatDividendsSection(data, "sms");

		expect(result).not.toBeNull();
		expect(result).toBe("AAPL: Ex-div 02-11, $0.24");
	});

	it("Formats email dividend section with pay date and currency.", () => {
		const data = new Map<string, DividendEvent[]>([
			[
				"AAPL",
				[
					{
						symbol: "AAPL",
						exDate: "2026-02-11",
						payDate: "2026-02-18",
						amount: 0.24,
						currency: "USD",
					},
				],
			],
		]);

		const result = formatDividendsSection(data, "email");

		expect(result).not.toBeNull();
		expect(result).toContain("AAPL: Ex-div 02-11, pay 02-18, $0.24 USD");
	});

	it("Returns null when no dividend events exist.", () => {
		const data = new Map<string, DividendEvent[]>([["AAPL", []]]);

		const result = formatDividendsSection(data, "sms");

		expect(result).toBeNull();
	});

	it("Handles empty payDate in email format.", () => {
		const data = new Map<string, DividendEvent[]>([
			[
				"MSFT",
				[
					{
						symbol: "MSFT",
						exDate: "2026-02-14",
						payDate: "",
						amount: 0.75,
						currency: "USD",
					},
				],
			],
		]);

		const result = formatDividendsSection(data, "email");

		expect(result).not.toBeNull();
		expect(result).toBe("MSFT: Ex-div 02-14, $0.75 USD");
		expect(result).not.toContain("pay");
	});

	it("Formats multiple tickers with multiple events.", () => {
		const data = new Map<string, DividendEvent[]>([
			[
				"AAPL",
				[
					{
						symbol: "AAPL",
						exDate: "2026-02-11",
						payDate: "2026-02-18",
						amount: 0.24,
						currency: "USD",
					},
				],
			],
			[
				"MSFT",
				[
					{
						symbol: "MSFT",
						exDate: "2026-02-12",
						payDate: "2026-02-19",
						amount: 0.75,
						currency: "USD",
					},
				],
			],
		]);

		const result = formatDividendsSection(data, "sms");

		expect(result).not.toBeNull();
		const lines = result?.split("\n");
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("AAPL");
		expect(lines[1]).toContain("MSFT");
	});
});
