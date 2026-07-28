import { describe, expect, it } from "vitest";
import {
	orderCardsByWatchlist,
	selectAssetEventCards,
} from "../../../src/lib/prediction-markets/select";
import type { PredictionMarketEventCard } from "../../../src/lib/prediction-markets/types";

function card(
	partial: Partial<PredictionMarketEventCard> & Pick<PredictionMarketEventCard, "key" | "title">,
): PredictionMarketEventCard {
	return {
		venue: "polymarket",
		url: "https://example.com",
		shape: "binary",
		shapeValidated: true,
		volume: 1000,
		closesAt: null,
		refreshedAt: new Date().toISOString(),
		outcomes: [
			{
				venueContractId: "yes",
				label: "Yes",
				probabilityPercent: 50,
				sortOrder: 0,
				strikeValue: null,
				volume: 1,
			},
		],
		...partial,
	};
}

describe("selectAssetEventCards", () => {
	const nowMs = Date.parse("2026-07-10T12:00:00.000Z");

	it("picks only the soonest future close and rejects expired", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "expired",
					title: "Expired",
					closesAt: "2026-07-01T00:00:00.000Z",
				}),
				card({
					key: "late",
					title: "Late",
					closesAt: "2026-09-01T00:00:00.000Z",
				}),
				card({
					key: "soon",
					title: "Soon",
					closesAt: "2026-07-15T00:00:00.000Z",
				}),
				card({
					key: "sooner",
					title: "Sooner",
					closesAt: "2026-07-12T00:00:00.000Z",
				}),
			],
			{ nowMs },
		);
		expect(selected.map((c) => c.key)).toEqual(["sooner"]);
	});

	it("omits stale snapshots older than 48h", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "stale",
					title: "Stale",
					closesAt: "2026-08-01T00:00:00.000Z",
					refreshedAt: "2026-07-07T00:00:00.000Z",
				}),
			],
			{ nowMs },
		);
		expect(selected).toEqual([]);
	});

	it("prefers a dated close over higher-volume ongoing for the same ticker", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "d1",
					title: "Dated low",
					closesAt: "2026-07-20T00:00:00.000Z",
					volume: 100,
					symbol: "GOOGL",
				}),
				card({
					key: "d2",
					title: "Dated high",
					closesAt: "2026-07-25T00:00:00.000Z",
					volume: 300,
					symbol: "GOOGL",
				}),
				card({
					key: "ongoing",
					title: "Next Google Gemini Pro Model",
					closesAt: null,
					volume: 2500,
					symbol: "GOOGL",
					outcomes: [
						{
							venueContractId: "yes",
							label: "Yes",
							probabilityPercent: 40,
							sortOrder: 0,
							strikeValue: null,
							volume: 2500,
							highlighted: true,
						},
					],
				}),
			],
			{ nowMs },
		);
		expect(selected.map((c) => c.key)).toEqual(["d1"]);
	});

	it("falls back to the highest-volume title-salient ongoing when no dated close", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "quiet",
					title: "Quiet Google rumor",
					closesAt: null,
					volume: 50,
					symbol: "GOOGL",
				}),
				card({
					key: "ongoing",
					title: "Next Google Gemini Pro Model",
					closesAt: null,
					volume: 250,
					symbol: "GOOGL",
					outcomes: [
						{
							venueContractId: "yes",
							label: "Yes",
							probabilityPercent: 40,
							sortOrder: 0,
							strikeValue: null,
							volume: 250,
							highlighted: true,
						},
					],
				}),
				card({
					key: "zero",
					title: "Zero volume GOOGL",
					closesAt: null,
					volume: 0,
					symbol: "GOOGL",
				}),
			],
			{ nowMs },
		);
		expect(selected.map((c) => c.key)).toEqual(["ongoing"]);
	});

	it("never returns more than one card even when many NVDA markets match", () => {
		const flood = [
			card({
				key: "nvda-dated-a",
				title: "Will NVDA close above $140?",
				closesAt: "2026-07-18T00:00:00.000Z",
				volume: 900,
				symbol: "NVDA",
			}),
			card({
				key: "nvda-dated-b",
				title: "Will NVDA close above $150?",
				closesAt: "2026-07-14T00:00:00.000Z",
				volume: 800,
				symbol: "NVDA",
			}),
			card({
				key: "nvda-dated-c",
				title: "NVDA earnings beat?",
				closesAt: "2026-08-01T00:00:00.000Z",
				volume: 2000,
				symbol: "NVDA",
			}),
			card({
				key: "nvda-ongoing-a",
				title: "Next NVIDIA GPU architecture",
				closesAt: null,
				volume: 5000,
				symbol: "NVDA",
				outcomes: [
					{
						venueContractId: "yes",
						label: "Yes",
						probabilityPercent: 55,
						sortOrder: 0,
						strikeValue: null,
						volume: 5000,
						highlighted: true,
					},
				],
			}),
			card({
				key: "nvda-ongoing-b",
				title: "NVIDIA market share in AI chips",
				closesAt: null,
				volume: 4000,
				symbol: "NVDA",
			}),
		];
		const selected = selectAssetEventCards(flood, { nowMs });
		expect(selected).toHaveLength(1);
		expect(selected[0]?.key).toBe("nvda-dated-b");
	});
});

describe("orderCardsByWatchlist", () => {
	it("follows newest-first watchlist order", () => {
		const bySymbol = new Map([
			["AAPL", [card({ key: "a", title: "A", symbol: "AAPL" })]],
			["NVDA", [card({ key: "n", title: "N", symbol: "NVDA" })]],
		]);
		const ordered = orderCardsByWatchlist(bySymbol, ["NVDA", "AAPL"]);
		expect(ordered.map((c) => c.symbol)).toEqual(["NVDA", "AAPL"]);
	});
});
