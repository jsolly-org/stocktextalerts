import { describe, expect, it } from "vitest";
import {
	type EarningsEvent,
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
