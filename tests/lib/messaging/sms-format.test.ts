import { describe, expect, it } from "vitest";
import { formatSmsMessage } from "../../../src/lib/messaging/sms/delivery";
import type { UserAssetRow } from "../../../src/lib/messaging/types";

describe("SMS scheduled update includes asset price data.", () => {
	it("Prices and daily change appear in the SMS message.", async () => {
		const assetsList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation — $412.10 (-0.31%)";

		const message = await formatSmsMessage(assetsList, true);

		expect(message).toContain("$187.42");
		expect(message).toContain("+1.23%");
		expect(message).toContain("$412.10");
		expect(message).toContain("-0.31%");
		expect(message).toContain("Reply STOP to opt out.");
	});

	it("Market-closed disclaimer appears when market is closed.", async () => {
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = await formatSmsMessage(assetsList, false);

		expect(message).toContain("Market Closed");
		expect(message).toContain("Prices below reflect the last market close.");
		expect(message).toContain("Reply STOP to opt out.");
	});

	it("Market-closed disclaimer is absent when market is open.", async () => {
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = await formatSmsMessage(assetsList, true);

		expect(message).not.toContain("Prices as of last market close.");
	});

	it("Messages longer than 160 characters are not truncated.", async () => {
		const manyAssets: UserAssetRow[] = Array.from({ length: 8 }, (_, i) => ({
			symbol: `STK${i}`,
			name: `Asset Company Number ${i}`,
		}));
		const assetsList = manyAssets
			.map((s) => `${s.symbol} - ${s.name} — $100.00 (+1.00%)`)
			.join("\n");

		const message = await formatSmsMessage(assetsList, false);

		expect(message.length).toBeGreaterThan(160);
		// All assets present, none truncated
		for (const asset of manyAssets) {
			expect(message).toContain(asset.symbol);
		}
	});

	it("Empty asset list produces a simple message without market disclaimer.", async () => {
		const assetsList = "You don't have any tracked assets";

		const message = await formatSmsMessage(assetsList, false);

		expect(message).toContain("StockTextAlerts");
		expect(message).toContain("You don't have any tracked assets.");
		expect(message).toContain("Manage your settings:");
		expect(message).toContain("http://localhost/dashboard");
		expect(message).toContain("Reply STOP to opt out.");
		expect(message).not.toContain("Prices as of last market close.");
	});

	it("Includes StockTextAlerts header.", async () => {
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = await formatSmsMessage(assetsList, true);

		expect(message).toMatch(
			/^StockTextAlerts — Your scheduled price notification 📈\n\n/,
		);
	});

	it("Includes dashboard link.", async () => {
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = await formatSmsMessage(assetsList, true);

		expect(message).toContain("Manage your settings:");
		expect(message).toContain("http://localhost/dashboard");
	});

	it("Includes analyst consensus extras when provided.", async () => {
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = await formatSmsMessage(assetsList, true, {
			analyst: "AAPL: 32 Buy, 6 Hold, 1 Sell",
		});

		expect(message).toContain("📊 Analyst Consensus");
		expect(message).toContain("AAPL: 32 Buy, 6 Hold, 1 Sell");
	});

	it("Includes insider trades extras when provided.", async () => {
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = await formatSmsMessage(assetsList, true, {
			insider: "AAPL: Tim Cook sold 50k shares (02-01)",
		});

		expect(message).toContain("🏦 Insider Trades");
		expect(message).toContain("AAPL: Tim Cook sold 50k shares (02-01)");
	});

	it("Includes all extras sections when provided.", async () => {
		const assetsList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = await formatSmsMessage(assetsList, true, {
			news: "AAPL: Revenue beats",
			rumors: "AAPL: Unconfirmed chatter",
			analyst: "AAPL: 32 Buy, 6 Hold",
			insider: "AAPL: CEO sold shares",
		});

		expect(message).toContain("🗞️ News");
		expect(message).toContain("🤫 Rumors");
		expect(message).toContain("📊 Analyst Consensus");
		expect(message).toContain("🏦 Insider Trades");
	});

	it("ETF assets render correctly in SMS messages.", async () => {
		const assetsList =
			"SPY - SS SPDR S&P 500 ETF TRUST-US — $523.45 (+0.87%)\nQQQ - INVESCO QQQ TRUST SERIES 1 — $441.20 (-1.15%)";

		const message = await formatSmsMessage(assetsList, true);

		expect(message).toContain("SPY");
		expect(message).toContain("$523.45");
		expect(message).toContain("+0.87%");
		expect(message).toContain("QQQ");
		expect(message).toContain("$441.20");
		expect(message).toContain("-1.15%");
	});
});
