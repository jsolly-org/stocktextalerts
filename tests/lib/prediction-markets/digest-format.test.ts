import { describe, expect, it } from "vitest";
import {
	formatPredictionMarketsDigestEmailHtml,
	formatPredictionMarketsDigestTelegram,
	formatPredictionMarketsDigestText,
} from "../../../src/lib/prediction-markets/format";
import type { PredictionMarketsDigestContent } from "../../../src/lib/prediction-markets/types";

const content: PredictionMarketsDigestContent = {
	assetMarkets: [
		{
			key: "polymarket:c1",
			label: "NVDA: July hit",
			venue: "polymarket",
			probabilityPercent: 55,
			deltaPoints: 2,
			url: "https://polymarket.com/event/nvda",
			symbol: "NVDA",
			matchKind: "direct_price",
		},
	],
	macroMarkets: [
		{
			key: "recession_2026",
			label: "Recession '26",
			venue: "kalshi",
			probabilityPercent: 11,
			deltaPoints: null,
			url: "https://kalshi.com/markets/kxrecssnber/kxrecssnber-26",
		},
	],
};

describe("formatPredictionMarketsDigest*", () => {
	it("puts Your Assets before Macro Weather in text", () => {
		const text = formatPredictionMarketsDigestText(content);
		expect(text).toContain("Your Assets");
		expect(text).toContain("Macro Weather");
		expect(text?.indexOf("Your Assets")).toBeLessThan(text?.indexOf("Macro Weather") ?? 0);
	});

	it("puts Your Assets before Macro Weather in Telegram", () => {
		const formatted = formatPredictionMarketsDigestTelegram(content);
		expect(formatted?.text).toContain("Your Assets");
		expect(formatted?.text).toContain("Macro Weather");
		expect(formatted?.text.indexOf("Your Assets")).toBeLessThan(
			formatted?.text.indexOf("Macro Weather") ?? 0,
		);
	});

	it("puts Your Assets before Macro Weather in email HTML", () => {
		const html = formatPredictionMarketsDigestEmailHtml(content);
		expect(html).toContain("Your Assets");
		expect(html).toContain("Macro Weather");
		expect(html?.indexOf("Your Assets")).toBeLessThan(html?.indexOf("Macro Weather") ?? 0);
	});

	it("macro-only fallback works when asset markets are empty", () => {
		const macroOnly: PredictionMarketsDigestContent = {
			assetMarkets: [],
			macroMarkets: content.macroMarkets,
		};
		expect(formatPredictionMarketsDigestText(macroOnly)).toContain("Macro Weather");
		expect(formatPredictionMarketsDigestText(macroOnly)).not.toContain("Your Assets");
	});
});
