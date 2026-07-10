import { describe, expect, it } from "vitest";
import { formatMarketScheduledTelegram } from "../../../../src/lib/messaging/notifications/market-scheduled";

describe("formatMarketScheduledTelegram", () => {
	it("labels pre-market no-session-trade symbols and discloses data recency", () => {
		const message = formatMarketScheduledTelegram({
			userAssets: [
				{ symbol: "CACI", name: "CACI International" },
				{ symbol: "AAPL", name: "Apple" },
			],
			assetPrices: new Map([
				["CACI", null],
				["AAPL", { price: 210.5, changePercent: 1.25 }],
			]),
			noSessionTrade: new Set(["CACI"]),
			marketSession: "pre",
		});

		expect(message.text).toContain("CACI — no pre-market trades");
		expect(message.text).toContain("AAPL");
		expect(message.text).toContain("$210.50");
		expect(message.text).toContain("Prices delayed up to 15 minutes.");
	});

	it("labels after-hours no-session-trade symbols", () => {
		const message = formatMarketScheduledTelegram({
			userAssets: [{ symbol: "SAIC", name: "Science Applications International" }],
			assetPrices: new Map([["SAIC", null]]),
			noSessionTrade: new Set(["SAIC"]),
			marketSession: "after",
		});

		expect(message.text).toContain("SAIC — no after-hours trades");
		expect(message.text).not.toContain("SAIC — price unavailable");
	});

	it("keeps a plain fetch miss as price unavailable (not no-session-trade copy)", () => {
		const message = formatMarketScheduledTelegram({
			userAssets: [{ symbol: "CACI", name: "CACI International" }],
			assetPrices: new Map([["CACI", null]]),
			noSessionTrade: new Set(),
			marketSession: "pre",
		});

		expect(message.text).toContain("CACI — price unavailable");
		expect(message.text).not.toContain("no pre-market trades");
	});
});
