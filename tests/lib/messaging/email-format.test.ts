import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatEmailMessage } from "../../../src/lib/messaging/email/utils";
import type { UserAssetRow } from "../../../src/lib/messaging/types";
import type { AssetPriceMap } from "../../../src/lib/providers/price-fetcher";

describe("Email scheduled update includes asset price data.", () => {
	const testUser = { id: "test-user-id", email: "test@example.com" };
	const testAssets: UserAssetRow[] = [
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
		const priceMap: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);
		const assetsList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation — $412.10 (-0.31%)";

		const { text, html } = formatEmailMessage(
			testUser,
			testAssets,
			assetsList,
			priceMap,
			true,
		);

		// Plain text includes prices via assetsList
		expect(text).toContain("$187.42");
		expect(text).toContain("+1.23%");
		expect(text).toContain("$412.10");
		expect(text).toContain("-0.31%");

		// HTML includes prices
		expect(html).toContain("$187.42");
		expect(html).toContain("$412.10");

		// Green for positive change, red for negative
		expect(html).toContain("color: #15803d;");
		expect(html).toContain("color: #dc2626;");
	});

	it("Market-closed disclaimer appears when market is closed.", () => {
		const priceMap: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const { text, html } = formatEmailMessage(
			testUser,
			[testAssets[0]],
			assetsList,
			priceMap,
			false,
		);

		expect(text).toContain("Market Closed");
		expect(text).toContain("Prices below reflect the last market close.");
		expect(html).toContain("Market Closed");
		expect(html).toContain("Prices below reflect the last market close.");
	});

	it("Market-closed disclaimer is absent when market is open.", () => {
		const priceMap: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
		]);
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const { text, html } = formatEmailMessage(
			testUser,
			[testAssets[0]],
			assetsList,
			priceMap,
			true,
		);

		expect(text).not.toContain("Prices as of last market close");
		expect(html).not.toContain("Prices as of last market close");
	});

	it("Assets without price data fall back to symbol and name only.", () => {
		const priceMap: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", null],
		]);
		const assetsList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation";

		const { html } = formatEmailMessage(
			testUser,
			testAssets,
			assetsList,
			priceMap,
			true,
		);

		// AAPL has price in HTML
		expect(html).toContain("$187.42");
		// MSFT appears without price (no mdash separator)
		expect(html).toContain("MSFT");
		expect(html).not.toContain("MSFT &mdash;");
	});

	it("ETF assets render with the same format as stocks in email.", () => {
		const etfAssets: UserAssetRow[] = [
			{ symbol: "SPY", name: "SS SPDR S&P 500 ETF TRUST-US" },
			{ symbol: "QQQ", name: "INVESCO QQQ TRUST SERIES 1" },
		];
		const priceMap: AssetPriceMap = new Map([
			["SPY", { price: 523.45, changePercent: 0.87 }],
			["QQQ", { price: 441.2, changePercent: -1.15 }],
		]);
		const assetsList =
			"SPY - SS SPDR S&P 500 ETF TRUST-US — $523.45 (+0.87%)\nQQQ - INVESCO QQQ TRUST SERIES 1 — $441.20 (-1.15%)";

		const { text, html } = formatEmailMessage(
			testUser,
			etfAssets,
			assetsList,
			priceMap,
			true,
		);

		// Plain text includes ETF prices
		expect(text).toContain("$523.45");
		expect(text).toContain("+0.87%");
		expect(text).toContain("$441.20");
		expect(text).toContain("-1.15%");

		// HTML includes ETF symbols and prices
		expect(html).toContain("SPY");
		expect(html).toContain("$523.45");
		expect(html).toContain("QQQ");
		expect(html).toContain("$441.20");

		// Green for positive change, red for negative
		expect(html).toContain("color: #15803d;");
		expect(html).toContain("color: #dc2626;");
	});
});
