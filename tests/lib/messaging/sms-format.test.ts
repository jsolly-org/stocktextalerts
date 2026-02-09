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

		expect(message).toContain("Stock Text Alerts");
		expect(message).toContain("You don't have any tracked stocks.");
		expect(message).toContain("Manage your stocks: http://localhost/dashboard");
		expect(message).toContain("Reply STOP to opt out.");
		expect(message).not.toContain("Prices as of last market close.");
	});

	it("Includes Stock Text Alerts header.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true);

		expect(message).toMatch(/^Stock Text Alerts\n\n/);
	});

	it("Includes dashboard link.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage(stocksList, true);

		expect(message).toContain("Manage your stocks: http://localhost/dashboard");
	});
});
