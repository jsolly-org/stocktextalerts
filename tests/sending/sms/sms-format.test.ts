import { describe, expect, it } from "vitest";
import { formatSmsMessage } from "../../../src/lib/messaging/sms/delivery";
import type { UserStockRow } from "../../../src/lib/messaging/types";

describe("SMS scheduled update includes stock price data.", () => {
	const testStocks: UserStockRow[] = [
		{ symbol: "AAPL", name: "Apple Inc." },
		{ symbol: "MSFT", name: "Microsoft Corporation" },
	];

	it("Prices and daily change appear in the SMS message.", () => {
		const stocksList =
			"AAPL - Apple Inc. — $187.42 (+1.23%)\nMSFT - Microsoft Corporation — $412.10 (-0.31%)";

		const message = formatSmsMessage(testStocks, stocksList, true);

		expect(message).toContain("$187.42");
		expect(message).toContain("+1.23%");
		expect(message).toContain("$412.10");
		expect(message).toContain("-0.31%");
		expect(message).toContain("Reply STOP to opt out.");
	});

	it("Market-closed disclaimer appears when market is closed.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage([testStocks[0]], stocksList, false);

		expect(message).toContain("Prices as of last market close.");
		expect(message).toContain("Reply STOP to opt out.");
	});

	it("Market-closed disclaimer is absent when market is open.", () => {
		const stocksList = "AAPL - Apple Inc. — $187.42 (+1.23%)";

		const message = formatSmsMessage([testStocks[0]], stocksList, true);

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

		const message = formatSmsMessage(manyStocks, stocksList, false);

		expect(message.length).toBeGreaterThan(160);
		// All stocks present, none truncated
		for (const stock of manyStocks) {
			expect(message).toContain(stock.symbol);
		}
	});

	it("Empty stock list produces a simple message without market disclaimer.", () => {
		const stocksList = "You don't have any tracked stocks";

		const message = formatSmsMessage([], stocksList, false);

		expect(message).toBe(
			"You don't have any tracked stocks. Reply STOP to opt out.",
		);
		expect(message).not.toContain("Prices as of last market close.");
	});
});
