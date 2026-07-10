import { describe, expect, it } from "vitest";
import {
	formatEventCardEmailHtml,
	formatEventCardText,
	formatPredictionMarketsEmailHtml,
	formatPredictionMarketsTelegram,
	formatPredictionMarketsText,
} from "../../../src/lib/prediction-markets/format";
import type {
	PredictionMarketEventCard,
	PredictionMarketReading,
} from "../../../src/lib/prediction-markets/types";
import { kalshiMarketUrl, polymarketMarketUrl } from "../../../src/lib/prediction-markets/urls";

const binaryCard: PredictionMarketEventCard = {
	key: "recession_2026",
	title: "Recession '26",
	venue: "kalshi",
	url: "https://kalshi.com/markets/kxrecssnber/kxrecssnber-26",
	shape: "binary",
	shapeValidated: true,
	closesAt: "2026-12-31T00:00:00.000Z",
	refreshedAt: "2026-07-10T12:00:00.000Z",
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
};

const exclusiveCard: PredictionMarketEventCard = {
	key: "ai-race",
	title: "Which company leads AI?",
	venue: "polymarket",
	url: "https://polymarket.com/event/ai",
	shape: "exclusive",
	shapeValidated: true,
	closesAt: "2026-08-01T00:00:00.000Z",
	refreshedAt: "2026-07-10T12:00:00.000Z",
	volume: 5000,
	symbol: "GOOGL",
	outcomes: [
		{
			venueContractId: "o",
			label: "OpenAI",
			probabilityPercent: 40,
			sortOrder: 0,
			strikeValue: null,
			volume: 1,
		},
		{
			venueContractId: "a",
			label: "Anthropic",
			probabilityPercent: 30,
			sortOrder: 1,
			strikeValue: null,
			volume: 1,
		},
		{
			venueContractId: "g",
			label: "Google",
			probabilityPercent: 12,
			sortOrder: 2,
			strikeValue: null,
			volume: 1,
			highlighted: true,
		},
		{
			venueContractId: "m",
			label: "Meta",
			probabilityPercent: 10,
			sortOrder: 3,
			strikeValue: null,
			volume: 1,
		},
		{
			venueContractId: "x",
			label: "xAI",
			probabilityPercent: 5,
			sortOrder: 4,
			strikeValue: null,
			volume: 1,
		},
		{
			venueContractId: "z",
			label: "Other",
			probabilityPercent: 3,
			sortOrder: 5,
			strikeValue: null,
			volume: 1,
		},
	],
};

const formatOpts = { timeZone: "UTC", use24Hour: true };

describe("formatEventCardText", () => {
	it("renders binary Yes/No without deltas", () => {
		const text = formatEventCardText(binaryCard, formatOpts);
		expect(text).toContain("Yes");
		expect(text).toContain("No");
		expect(text).toContain("11%");
		expect(text).toContain("Updated");
		expect(text).not.toContain("▲");
		expect(text).not.toContain("▼");
	});

	it("renders exclusive fields with all ≤6 outcomes", () => {
		const text = formatEventCardText(exclusiveCard, formatOpts);
		expect(text).toContain("Google");
		expect(text).toContain("★");
		expect(text).toContain("OpenAI");
		expect(text).not.toContain("Others");
	});
});

describe("formatEventCardEmailHtml", () => {
	it("renders card shell with venue link", () => {
		const html = formatEventCardEmailHtml(binaryCard, formatOpts);
		expect(html).toContain("Recession &#39;26");
		expect(html).toContain('href="https://kalshi.com/markets/kxrecssnber/kxrecssnber-26"');
		expect(html).toContain("View full market");
		expect(html).toContain("Yes");
		expect(html).toContain("No");
	});
});

const sampleReadings: PredictionMarketReading[] = [
	{
		key: "recession_2026",
		label: "Recession '26",
		venue: "kalshi",
		probabilityPercent: 10.4,
		deltaPoints: 2,
		url: "https://kalshi.com/markets/kxrecssnber/kxrecssnber-26",
	},
	{
		key: "fed_cut_by_2027",
		label: "Fed cut by '27",
		venue: "kalshi",
		probabilityPercent: 23,
		deltaPoints: -5,
		url: "https://kalshi.com/markets/kxratecut/kxratecut-26dec31",
	},
	{
		key: "spx_best_2026",
		label: "S&P best '26",
		venue: "polymarket",
		probabilityPercent: 70,
		deltaPoints: null,
		url: "https://polymarket.com/event/will-the-sp-500-have-the-best-performance-in-2026-545",
	},
];

describe("legacy formatPredictionMarketsText", () => {
	it("renders stacked rows without requiring deltas", () => {
		const text = formatPredictionMarketsText(sampleReadings);
		expect(text).toContain("Recession '26");
		expect(text).toContain("10%");
		expect(text).toContain("Fed cut by '27");
	});

	it("returns null for an empty strip", () => {
		expect(formatPredictionMarketsText([])).toBeNull();
	});
});

describe("legacy formatPredictionMarketsTelegram", () => {
	it("links each market label via text_link entities", () => {
		const formatted = formatPredictionMarketsTelegram(sampleReadings);
		expect(formatted).not.toBeNull();
		const linkEntities = (formatted?.entities ?? []).filter((e) => e.type === "text_link");
		expect(linkEntities).toHaveLength(3);
	});
});

describe("legacy formatPredictionMarketsEmailHtml", () => {
	it("renders binary cards from scalar readings", () => {
		const html = formatPredictionMarketsEmailHtml(sampleReadings);
		expect(html).toContain("Recession &#39;26");
		expect(html).toContain('href="https://kalshi.com/markets/kxrecssnber/kxrecssnber-26"');
		expect(html).toContain(
			'href="https://polymarket.com/event/will-the-sp-500-have-the-best-performance-in-2026-545"',
		);
	});
});

describe("url helpers still used by fixtures", () => {
	it("builds venue urls", () => {
		expect(kalshiMarketUrl("kxrecssnber-26", "kxrecssnber")).toContain("kalshi.com");
		expect(polymarketMarketUrl("slug", "event")).toContain("polymarket.com");
	});
});
