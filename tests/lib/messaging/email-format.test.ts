import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMarketScheduledEmail } from "../../../src/lib/messaging/notifications/market-scheduled";
import type { AssetPriceMap, UserAssetRow } from "../../../src/lib/types";

describe("Email scheduled update includes asset price data.", () => {
	const testUser = { id: "test-user-id", email: "test@example.com" };
	const testAssets: [UserAssetRow, UserAssetRow] = [
		{ symbol: "AAPL", name: "Apple Inc." },
		{ symbol: "MSFT", name: "Microsoft Corporation" },
	];

	beforeEach(() => {
		vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", "test-secret-key");
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

		const { text, html } = formatMarketScheduledEmail(
			testUser,
			testAssets,
			assetsList,
			priceMap,
			"regular",
		);

		// Plain text includes prices via assetsList
		expect(text).toContain("$187.42");
		expect(text).toContain("+1.23%");
		expect(text).toContain("$412.10");
		expect(text).toContain("-0.31%");

		// HTML includes prices
		expect(html).toContain("$187.42");
		expect(html).toContain("$412.10");

		// Green for positive (green-800), red for negative (red-700) — WCAG contrast
		expect(html).toContain("color: #166534;");
		expect(html).toContain("color: #b91c1c;");
	});

	it("Scheduled-email asset wrapper uses readable sans-serif at mobile-friendly size, not the legacy 18px Courier scoreboard", () => {
		// Courier New at 18px bold pushed every row past the ~230px-wide asset
		// list container on iOS Mail — the right side (sparkline, then label)
		// was clipped. Inherit the body's sans-serif at a smaller size so rows
		// fit common mobile viewports.
		const priceMap: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);
		const { html } = formatMarketScheduledEmail(
			testUser,
			[testAssets[0]],
			"AAPL — $187.42",
			priceMap,
			"regular",
		);
		expect(html).not.toContain("'Courier New', monospace");
		expect(html).not.toContain("font-size: 18px");
	});

	it("Market-closed disclaimer appears when market is closed.", () => {
		const priceMap: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const { text, html } = formatMarketScheduledEmail(
			testUser,
			[testAssets[0]],
			assetsList,
			priceMap,
			"closed",
		);

		expect(text).toContain("Market Closed");
		expect(text).toContain("Prices below reflect the last market close.");
		expect(html).toContain("Market Closed");
		expect(html).toContain("Prices below reflect the last market close.");
	});

	it("Market-closed disclaimer is absent when market is open.", () => {
		const priceMap: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const { text, html } = formatMarketScheduledEmail(
			testUser,
			[testAssets[0]],
			assetsList,
			priceMap,
			"regular",
		);

		expect(text).not.toContain("Prices as of last market close");
		expect(html).not.toContain("Prices as of last market close");
	});

	it("Assets without price data fall back to symbol and name only.", () => {
		const priceMap: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", null],
		]);
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation";

		const { html } = formatMarketScheduledEmail(
			testUser,
			testAssets,
			assetsList,
			priceMap,
			"regular",
		);

		// AAPL has price in HTML
		expect(html).toContain("$187.42");
		// MSFT renders a "price unavailable" row, never a price figure
		expect(html).toContain(">MSFT</td>");
		expect(html).toContain("price unavailable");
		expect(html).not.toContain("$0.00");
		expect(html).not.toContain("$412.10");
	});

	it("A scheduled-email recipient sees an inline AAPL logo while symbols without logos remain text-only.", () => {
		const priceMap: AssetPriceMap = new Map([
			["AAPL", { price: 187.42, changePercent: 1.23 }],
			["MSFT", { price: 412.1, changePercent: -0.31 }],
		]);
		const assetsList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation — $412.10 (-0.31%)";

		const getLogoHtml = (symbol: string) =>
			symbol === "AAPL"
				? '<img src="data:image/png;base64,aapllogo" alt="" width="20" height="20" />'
				: undefined;

		const { html } = formatMarketScheduledEmail(
			testUser,
			testAssets,
			assetsList,
			priceMap,
			"regular",
			{
				getLogoHtml,
			},
		);

		expect(html).toContain("base64,aapllogo");
		// Logo lives in the cell immediately before the AAPL ticker cell.
		expect(html).toMatch(
			/<td[^>]*>\s*<img src="data:image\/png;base64,aapllogo"[^>]*\/>\s*<\/td>\s*<td[^>]*>AAPL<\/td>/,
		);
		// MSFT should not have a logo img
		expect(html).not.toContain("msftlogo");
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

		const { text, html } = formatMarketScheduledEmail(
			testUser,
			etfAssets,
			assetsList,
			priceMap,
			"regular",
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

		// Green for positive (green-800), red for negative (red-700) — WCAG contrast
		expect(html).toContain("color: #166534;");
		expect(html).toContain("color: #b91c1c;");
	});
});
