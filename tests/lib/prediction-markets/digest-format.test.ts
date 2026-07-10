import { describe, expect, it } from "vitest";
import {
	formatPredictionMarketsDigestEmailHtml,
	formatPredictionMarketsDigestTelegram,
	formatPredictionMarketsDigestText,
} from "../../../src/lib/prediction-markets/format";
import type { PredictionMarketsDigestContent } from "../../../src/lib/prediction-markets/types";

const content: PredictionMarketsDigestContent = {
	assetCards: [
		{
			key: "polymarket:nvda",
			title: "Will NVDA hit $200 in July?",
			venue: "polymarket",
			url: "https://polymarket.com/event/nvda",
			shape: "binary",
			shapeValidated: true,
			closesAt: "2026-07-31T20:00:00.000Z",
			refreshedAt: "2026-07-10T00:00:00.000Z",
			volume: 1000,
			symbol: "NVDA",
			matchKind: "direct_price",
			outcomes: [
				{
					venueContractId: "yes",
					label: "Yes",
					probabilityPercent: 55,
					sortOrder: 0,
					strikeValue: null,
					volume: 500,
				},
				{
					venueContractId: "no",
					label: "No",
					probabilityPercent: 45,
					sortOrder: 1,
					strikeValue: null,
					volume: 500,
				},
			],
		},
	],
	macroCards: [
		{
			key: "recession_2026",
			title: "Recession '26",
			venue: "kalshi",
			url: "https://kalshi.com/markets/kxrecssnber/kxrecssnber-26",
			shape: "binary",
			shapeValidated: true,
			closesAt: "2026-12-31T00:00:00.000Z",
			refreshedAt: "2026-07-10T00:00:00.000Z",
			volume: 0,
			outcomes: [
				{
					venueContractId: "yes",
					label: "Yes",
					probabilityPercent: 11,
					sortOrder: 0,
					strikeValue: null,
					volume: 0,
				},
				{
					venueContractId: "no",
					label: "No",
					probabilityPercent: 89,
					sortOrder: 1,
					strikeValue: null,
					volume: 0,
				},
			],
		},
	],
};

const formatOpts = { timeZone: "America/New_York", use24Hour: false };

describe("formatPredictionMarketsDigest*", () => {
	it("puts Your Assets before Macro Weather in text", () => {
		const text = formatPredictionMarketsDigestText(content, formatOpts);
		expect(text).toContain("Your Assets");
		expect(text).toContain("Macro Weather");
		expect(text?.indexOf("Your Assets")).toBeLessThan(text?.indexOf("Macro Weather") ?? 0);
		expect(text).toContain("Yes");
		expect(text).toContain("No");
		expect(text).toContain("Updated");
	});

	it("puts Your Assets before Macro Weather in Telegram", () => {
		const formatted = formatPredictionMarketsDigestTelegram(content, formatOpts);
		expect(formatted?.text).toContain("Your Assets");
		expect(formatted?.text).toContain("Macro Weather");
		expect(formatted?.text.indexOf("Your Assets")).toBeLessThan(
			formatted?.text.indexOf("Macro Weather") ?? 0,
		);
	});

	it("puts Your Assets before Macro Weather in email HTML", () => {
		const html = formatPredictionMarketsDigestEmailHtml(content, formatOpts);
		expect(html).toContain("Your Assets");
		expect(html).toContain("Macro Weather");
		expect(html?.indexOf("Your Assets")).toBeLessThan(html?.indexOf("Macro Weather") ?? 0);
		expect(html).toContain("View full market");
	});

	it("macro-only fallback works when asset markets are empty", () => {
		const macroOnly: PredictionMarketsDigestContent = {
			assetCards: [],
			macroCards: content.macroCards,
		};
		expect(formatPredictionMarketsDigestText(macroOnly, formatOpts)).toContain("Macro Weather");
		expect(formatPredictionMarketsDigestText(macroOnly, formatOpts)).not.toContain("Your Assets");
	});
});
