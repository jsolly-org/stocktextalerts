import { describe, expect, it } from "vitest";
import {
	formatPredictionMarketsEmailHtml,
	formatPredictionMarketsTelegram,
	formatPredictionMarketsText,
} from "../../../src/lib/prediction-markets/format";
import { attachPredictionMarketDeltas } from "../../../src/lib/prediction-markets/store";
import type { PredictionMarketReading } from "../../../src/lib/prediction-markets/types";
import { kalshiMarketUrl, polymarketMarketUrl } from "../../../src/lib/prediction-markets/urls";

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

describe("formatPredictionMarketsText", () => {
	it("renders stacked rows with unicode probability bars", () => {
		expect(formatPredictionMarketsText(sampleReadings)).toBe(
			[
				"Recession '26    10%  █░░░░░░░░░  ▲2",
				"Fed cut by '27   23%  ██░░░░░░░░  ▼5",
				"S&P best '26     70%  ███████░░░  —",
			].join("\n"),
		);
	});

	it("returns null for an empty strip", () => {
		expect(formatPredictionMarketsText([])).toBeNull();
	});
});

describe("formatPredictionMarketsTelegram", () => {
	it("links each market label via text_link entities", () => {
		const formatted = formatPredictionMarketsTelegram(sampleReadings);
		expect(formatted).not.toBeNull();
		expect(formatted?.text).toContain("Recession '26");
		expect(formatted?.text).toContain("█░░░░░░░░░");
		const linkEntities = (formatted?.entities ?? []).filter((e) => e.type === "text_link");
		expect(linkEntities).toHaveLength(3);
		expect(linkEntities.map((e) => ("url" in e ? e.url : null))).toEqual([
			sampleReadings[0]?.url,
			sampleReadings[1]?.url,
			sampleReadings[2]?.url,
		]);
	});

	it("returns null for an empty strip", () => {
		expect(formatPredictionMarketsTelegram([])).toBeNull();
	});
});

describe("formatPredictionMarketsEmailHtml", () => {
	it("renders probability bars, venue labels, and market links", () => {
		const html = formatPredictionMarketsEmailHtml(sampleReadings);
		expect(html).toContain("Recession &#39;26");
		expect(html).toContain('href="https://kalshi.com/markets/kxrecssnber/kxrecssnber-26"');
		expect(html).toContain(
			'href="https://polymarket.com/event/will-the-sp-500-have-the-best-performance-in-2026-545"',
		);
		expect(html).toContain("Kalshi");
		expect(html).toContain("Polymarket");
		expect(html).toContain("width: 10%");
		expect(html).toContain("width: 70%");
		expect(html).toContain("▲2");
		expect(html).toContain("▼5");
		expect(html).toContain("#059669");
		expect(html).toContain("#dc2626");
	});

	it("returns null for an empty strip", () => {
		expect(formatPredictionMarketsEmailHtml([])).toBeNull();
	});
});

describe("prediction market URL builders", () => {
	it("builds Kalshi and Polymarket public pages", () => {
		expect(kalshiMarketUrl("KXRECSSNBER-26")).toBe(
			"https://kalshi.com/markets/kxrecssnber/kxrecssnber-26",
		);
		expect(kalshiMarketUrl("KXRATECUT-26DEC31", "KXRATECUT-26DEC31")).toBe(
			"https://kalshi.com/markets/kxratecut/kxratecut-26dec31",
		);
		expect(polymarketMarketUrl("fed-rate-cut-by-december-2026-meeting")).toBe(
			"https://polymarket.com/event/fed-rate-cut-by-december-2026-meeting",
		);
		expect(
			polymarketMarketUrl("fed-rate-cut-by-december-2026-meeting", "fed-rate-cut-by-629"),
		).toBe(
			"https://polymarket.com/event/fed-rate-cut-by-629/fed-rate-cut-by-december-2026-meeting",
		);
	});
});

describe("attachPredictionMarketDeltas", () => {
	it("computes percentage-point deltas from a baseline map", () => {
		const readings: PredictionMarketReading[] = [
			{
				key: "recession_2026",
				label: "Recession '26",
				venue: "kalshi",
				probabilityPercent: 12,
				deltaPoints: null,
				url: "https://kalshi.com/markets/kxrecssnber/kxrecssnber-26",
			},
		];
		const withDeltas = attachPredictionMarketDeltas(readings, new Map([["recession_2026", 9]]));
		expect(withDeltas[0]?.deltaPoints).toBe(3);
		expect(withDeltas[0]?.url).toBe(readings[0]?.url);
	});

	it("keeps delta null when no baseline exists", () => {
		const readings: PredictionMarketReading[] = [
			{
				key: "recession_2026",
				label: "Recession '26",
				venue: "kalshi",
				probabilityPercent: 12,
				deltaPoints: null,
				url: "https://kalshi.com/markets/kxrecssnber/kxrecssnber-26",
			},
		];
		const withDeltas = attachPredictionMarketDeltas(readings, new Map());
		expect(withDeltas[0]?.deltaPoints).toBeNull();
	});
});
