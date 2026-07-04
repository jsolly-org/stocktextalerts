import { describe, expect, it } from "vitest";
import { formatMarketScheduledSms } from "../../../../src/lib/messaging/notifications/market-scheduled";
import type { NotificationExtras } from "../../../../src/lib/messaging/types";
import type { AssetPriceMap, MarketSession, UserAssetRow } from "../../../../src/lib/types";

type PriceInput = { symbol: string; price: number; changePercent: number };

// The SMS formatter now renders its own asset list from raw data (userAssets + priceMap)
// instead of receiving a pre-rendered string, so tests supply the same raw inputs.
function smsOptions(
	assets: PriceInput[],
	marketSession: MarketSession,
	extras?: NotificationExtras,
): Parameters<typeof formatMarketScheduledSms>[0] {
	const userAssets: UserAssetRow[] = assets.map((a) => ({ symbol: a.symbol, name: a.symbol }));
	const priceMap: AssetPriceMap = new Map(
		assets.map((a) => [a.symbol, { price: a.price, changePercent: a.changePercent }]),
	);
	return { userAssets, priceMap, marketSession, extras };
}

describe("SMS scheduled update includes asset price data.", () => {
	it("Prices and daily change appear in the SMS message.", () => {
		const message = formatMarketScheduledSms(
			smsOptions(
				[
					{ symbol: "AAPL", price: 187.42, changePercent: 1.23 },
					{ symbol: "MSFT", price: 412.1, changePercent: -0.31 },
				],
				"regular",
			),
		);

		expect(message).toContain("$187.42");
		expect(message).toContain("+1.23%");
		expect(message).toContain("$412.10");
		expect(message).toContain("-0.31%");
		expect(message).toContain("Reply STOP to opt out.");
		// Footer contract: SMS now also carries the disclaimer.
		expect(message).toContain("Not financial advice.");
	});

	it("Market-closed disclaimer appears when market is closed.", () => {
		const message = formatMarketScheduledSms(
			smsOptions([{ symbol: "AAPL", price: 187.42, changePercent: 1.23 }], "closed"),
		);

		expect(message).toContain("Market Closed");
		expect(message).toContain("Prices below reflect the last market close.");
		expect(message).toContain("Reply STOP to opt out.");
	});

	it("Market-closed disclaimer is absent when market is open.", () => {
		const message = formatMarketScheduledSms(
			smsOptions([{ symbol: "AAPL", price: 187.42, changePercent: 1.23 }], "regular"),
		);

		expect(message).not.toContain("Prices as of last market close.");
	});

	it("Messages longer than 160 characters are not truncated.", () => {
		const manyAssets: PriceInput[] = Array.from({ length: 8 }, (_, i) => ({
			symbol: `STK${i}`,
			price: 100,
			changePercent: 1,
		}));

		const message = formatMarketScheduledSms(smsOptions(manyAssets, "closed"));

		expect(message.length).toBeGreaterThan(160);
		// All assets present, none truncated
		for (const asset of manyAssets) {
			expect(message).toContain(asset.symbol);
		}
	});

	it("Empty asset list produces a simple message without market disclaimer.", () => {
		const message = formatMarketScheduledSms(smsOptions([], "closed"));

		expect(message).toContain("StockTextAlerts");
		expect(message).toContain("You don't have any tracked assets.");
		expect(message).toContain("Manage your notifications:");
		expect(message).toContain("http://localhost/dashboard");
		expect(message).toContain("Reply STOP to opt out.");
		expect(message).not.toContain("Prices as of last market close.");
	});

	it("Includes StockTextAlerts header.", () => {
		const message = formatMarketScheduledSms(
			smsOptions([{ symbol: "AAPL", price: 187.42, changePercent: 1.23 }], "regular"),
		);

		expect(message).toMatch(/^StockTextAlerts — Your scheduled price notification 📈\n\n/);
	});

	it("Includes dashboard link.", () => {
		const message = formatMarketScheduledSms(
			smsOptions([{ symbol: "AAPL", price: 187.42, changePercent: 1.23 }], "regular"),
		);

		expect(message).toContain("Manage your notifications:");
		expect(message).toContain("http://localhost/dashboard");
	});

	it("Includes analyst consensus extras when provided.", () => {
		const message = formatMarketScheduledSms(
			smsOptions([{ symbol: "AAPL", price: 187.42, changePercent: 1.23 }], "regular", {
				analyst: "AAPL: 32 Buy, 6 Hold, 1 Sell",
			}),
		);

		expect(message).toContain("📊 Analyst Consensus");
		expect(message).toContain("AAPL: 32 Buy, 6 Hold, 1 Sell");
	});

	it("Includes insider trades extras when provided.", () => {
		const message = formatMarketScheduledSms(
			smsOptions([{ symbol: "AAPL", price: 187.42, changePercent: 1.23 }], "regular", {
				insider: "AAPL: Tim Cook sold 50k shares (02-01)",
			}),
		);

		expect(message).toContain("🏦 Insider Trades");
		expect(message).toContain("AAPL: Tim Cook sold 50k shares (02-01)");
	});

	it("Includes all extras sections when provided.", () => {
		const message = formatMarketScheduledSms(
			smsOptions([{ symbol: "AAPL", price: 187.42, changePercent: 1.23 }], "regular", {
				news: "AAPL: Revenue beats",
				rumors: "AAPL: Unconfirmed chatter",
				analyst: "AAPL: 32 Buy, 6 Hold",
				insider: "AAPL: CEO sold shares",
			}),
		);

		expect(message).toContain("🗞️ News");
		expect(message).toContain("🤫 Rumors");
		expect(message).toContain("📊 Analyst Consensus");
		expect(message).toContain("🏦 Insider Trades");
	});

	it("ETF assets render correctly in SMS messages.", () => {
		const message = formatMarketScheduledSms(
			smsOptions(
				[
					{ symbol: "SPY", price: 523.45, changePercent: 0.87 },
					{ symbol: "QQQ", price: 441.2, changePercent: -1.15 },
				],
				"regular",
			),
		);

		expect(message).toContain("SPY");
		expect(message).toContain("$523.45");
		expect(message).toContain("+0.87%");
		expect(message).toContain("QQQ");
		expect(message).toContain("$441.20");
		expect(message).toContain("-1.15%");
	});
});
