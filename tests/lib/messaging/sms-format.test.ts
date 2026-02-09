import { describe, expect, it } from "vitest";
import { formatSmsMessage } from "../../../src/lib/messaging/sms/delivery";
import type { UserStockRow } from "../../../src/lib/messaging/types";

describe("SMS scheduled update includes stock price data.", () => {
	it("Prices and daily change appear in the SMS message.", () => {
		const stocksList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation — $412.10 (-0.31%)";

		const message = formatSmsMessage(stocksList, true);

		expect(message).toContain("$187.42");
		expect(message).toContain("+1.23%");
		expect(message).toContain("$412.10");
		expect(message).toContain("-0.31%");
		expect(message).toContain("Reply STOP to opt out.");
	});

	it("Market-closed disclaimer appears when market is closed.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, false);

		expect(message).toContain("Prices as of last market close.");
		expect(message).toContain("Reply STOP to opt out.");
	});

	it("Market-closed disclaimer is absent when market is open.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true);

		expect(message).not.toContain("Prices as of last market close.");
	});

	it("Messages longer than 160 characters are not truncated.", () => {
		const manyStocks: UserStockRow[] = Array.from({ length: 8 }, (_, i) => ({
			symbol: `STK${i}`,
			name: `Stock Company Number ${i}`,
		}));
		const stocksList = manyStocks
			.map((s) => `${s.symbol} - ${s.name} — $100.00 (+1.00%)`)
			.join("\n");

		const message = formatSmsMessage(stocksList, false);

		expect(message.length).toBeGreaterThan(160);
		// All stocks present, none truncated
		for (const stock of manyStocks) {
			expect(message).toContain(stock.symbol);
		}
	});

	it("Empty stock list produces a simple message without market disclaimer.", () => {
		const stocksList = "You don't have any tracked stocks";

		const message = formatSmsMessage(stocksList, false);

		expect(message).toContain("StockTextAlerts");
		expect(message).toContain("You don't have any tracked stocks.");
		expect(message).toContain(
			"Manage your settings: http://localhost/dashboard",
		);
		expect(message).toContain("Reply STOP to opt out.");
		expect(message).not.toContain("Prices as of last market close.");
	});

	it("Includes StockTextAlerts header.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true);

		expect(message).toMatch(/^StockTextAlerts\n\n/);
	});

	it("Includes dashboard link.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true);

		expect(message).toContain(
			"Manage your settings: http://localhost/dashboard",
		);
	});

	it("Includes analyst consensus extras when provided.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true, {
			analyst: "AAPL: 32 Buy, 6 Hold, 1 Sell",
		});

		expect(message).toContain("📊 Analyst Consensus");
		expect(message).toContain("AAPL: 32 Buy, 6 Hold, 1 Sell");
	});

	it("Includes insider trades extras when provided.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true, {
			insider: "AAPL: Tim Cook sold 50k shares (02-01)",
		});

		expect(message).toContain("🏦 Insider Trades");
		expect(message).toContain("AAPL: Tim Cook sold 50k shares (02-01)");
	});

	it("Includes all extras sections when provided.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true, {
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
});
