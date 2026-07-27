import { describe, expect, it } from "vitest";
import { buildPredictionMarketCardSvg } from "../../../../src/lib/messaging/telegram/prediction-market-card";
import type { PredictionMarketEventCard } from "../../../../src/lib/prediction-markets/types";

function thresholdCard(
	overrides: Partial<PredictionMarketEventCard> = {},
): PredictionMarketEventCard {
	return {
		key: "polymarket:pltr-july",
		title: "Will Palantir (PLTR) close above ___ end of July?",
		venue: "polymarket",
		url: "https://polymarket.com/event/pltr",
		shape: "threshold",
		shapeValidated: true,
		closesAt: "2026-07-31T20:00:00.000Z",
		refreshedAt: "2026-07-26T00:01:00.000Z",
		volume: 10_000,
		symbol: "PLTR",
		matchKind: "direct_price",
		outcomes: [
			{
				venueContractId: "114",
				label: "$114",
				probabilityPercent: 85,
				sortOrder: 0,
				strikeValue: 114,
				volume: 1,
			},
			{
				venueContractId: "116",
				label: "$116",
				probabilityPercent: 68,
				sortOrder: 1,
				strikeValue: 116,
				volume: 1,
			},
			{
				venueContractId: "118",
				label: "$118",
				probabilityPercent: 75,
				sortOrder: 2,
				strikeValue: 118,
				volume: 1,
			},
			{
				venueContractId: "120",
				label: "$120",
				probabilityPercent: 68,
				sortOrder: 3,
				strikeValue: 120,
				volume: 1,
			},
		],
		...overrides,
	};
}

describe("buildPredictionMarketCardSvg", () => {
	it("returns empty string when there are no outcomes", () => {
		expect(buildPredictionMarketCardSvg(thresholdCard({ outcomes: [] }))).toBe("");
	});

	it("draws a fixed-width track and a fill scaled to probability", () => {
		const svg = buildPredictionMarketCardSvg(thresholdCard());
		expect(svg).toContain('width="720"');
		// Full track fills remaining width after label + percent columns (512 at default width).
		const tracks = svg.match(/width="512" height="10" rx="5" fill="#e5e7eb"/g) ?? [];
		expect(tracks.length).toBe(4);
		// 85% of 512 = 435.2
		expect(svg).toContain('width="435.2" height="10" fill="#4f46e5"');
		// 68% of 512 = 348.2
		expect(svg).toContain('width="348.2" height="10" fill="#4f46e5"');
	});

	it("right-anchors percent labels at a shared x column", () => {
		const svg = buildPredictionMarketCardSvg(thresholdCard());
		const pctTexts = svg.match(/text-anchor="end">\d+%/g) ?? [];
		expect(pctTexts).toEqual([
			'text-anchor="end">85%',
			'text-anchor="end">68%',
			'text-anchor="end">75%',
			'text-anchor="end">68%',
		]);
		// All percent texts share the same end-anchor x (card right padding).
		const endAnchors =
			svg.match(
				/x="704" y="[^"]+" font-family="Roboto[^"]*" font-size="14" font-weight="700"[^>]*text-anchor="end"/g,
			) ?? [];
		expect(endAnchors.length).toBe(4);
	});

	it("marks highlighted outcomes with a star", () => {
		const svg = buildPredictionMarketCardSvg(
			thresholdCard({
				outcomes: thresholdCard().outcomes.map((o, i) =>
					i === 1 ? { ...o, highlighted: true } : o,
				),
			}),
		);
		expect(svg).toContain("★ $116");
	});

	it("escapes special characters in the title", () => {
		const svg = buildPredictionMarketCardSvg(
			thresholdCard({ title: "Will A&B close above $100?" }),
		);
		expect(svg).toContain("A&amp;B");
		expect(svg).not.toContain("A&B close");
	});

	it("renders binary Yes/No cards", () => {
		const svg = buildPredictionMarketCardSvg({
			key: "recession",
			title: "Recession '26",
			venue: "kalshi",
			url: "https://kalshi.com/markets/x",
			shape: "binary",
			shapeValidated: true,
			closesAt: null,
			refreshedAt: "2026-07-26T00:01:00.000Z",
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
		});
		expect(svg).toContain(">Yes</text>");
		expect(svg).toContain(">No</text>");
		expect(svg).toContain('width="56.3" height="10" fill="#6366f1"'); // 11% of 512
	});
});
