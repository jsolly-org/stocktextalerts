import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatEmailMessage } from "../../../src/lib/messaging/email/utils";
import type { UserStockRow } from "../../../src/lib/messaging/types";
import type { StockPriceMap } from "../../../src/lib/price-fetcher";

describe("Email scheduled update includes stock price data.", () => {
	const testUser = { id: "test-user-id", email: "test@example.com" };
	const testStocks: UserStockRow[] = [
		{ symbol: "AAPL", name: "Apple Inc." },
		{ symbol: "MSFT", name: "Microsoft Corporation" },
	];

	beforeEach(() => {
		vi.stubEnv("CRON_SECRET", "test-secret");
		vi.stubEnv("VERCEL_URL", "http://localhost:4321");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("Prices and daily change appear in the HTML email with green/red coloring.", () => {
		const priceMap: StockPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);
		const stocksList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation — $412.10 (-0.31%)";

		const { text, html } = formatEmailMessage(
			testUser,
			testStocks,
			stocksList,
			priceMap,
			true,
		);

		// Plain text includes prices via stocksList
		expect(text).toContain("$187.42");
		expect(text).toContain("+1.23%");
		expect(text).toContain("$412.10");
		expect(text).toContain("-0.31%");

		// HTML includes prices
		expect(html).toContain("$187.42");
		expect(html).toContain("$412.10");

		// Green for positive change, red for negative
		expect(html).toContain("color: #16a34a;");
		expect(html).toContain("color: #dc2626;");
	});

	it("Market-closed disclaimer appears when market is closed.", () => {
		const priceMap: StockPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const { text, html } = formatEmailMessage(
			testUser,
			[testStocks[0]],
			stocksList,
			priceMap,
			false,
		);

		expect(text).toContain("Prices as of last market close");
		expect(html).toContain("Prices as of last market close");
	});

	it("Market-closed disclaimer is absent when market is open.", () => {
		const priceMap: StockPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const { text, html } = formatEmailMessage(
			testUser,
			[testStocks[0]],
			stocksList,
			priceMap,
			true,
		);

		expect(text).not.toContain("Prices as of last market close");
		expect(html).not.toContain("Prices as of last market close");
	});

	it("Stocks without price data fall back to symbol and name only.", () => {
		const priceMap: StockPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", null],
		]);
		const stocksList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation";

		const { html } = formatEmailMessage(
			testUser,
			testStocks,
			stocksList,
			priceMap,
			true,
		);

		// AAPL has price in HTML
		expect(html).toContain("$187.42");
		// MSFT appears without price (no mdash separator)
		expect(html).toContain("MSFT - Microsoft Corporation");
		expect(html).not.toContain("MSFT - Microsoft Corporation &mdash;");
	});
});
