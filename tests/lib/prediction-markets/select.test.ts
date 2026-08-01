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

function upDownOutcomes(upPercent: number, downPercent: number) {
	return [
		{
			venueContractId: "up",
			label: "Up",
			probabilityPercent: upPercent,
			sortOrder: 0,
			strikeValue: null,
			volume: 600,
		},
		{
			venueContractId: "down",
			label: "Down",
			probabilityPercent: downPercent,
			sortOrder: 1,
			strikeValue: null,
			volume: 600,
		},
	];
}

describe("selectAssetEventCards", () => {
	const nowMs = Date.parse("2026-07-10T12:00:00.000Z");

	it("returns empty when only price-target markets remain", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "price-a",
					title: "Will NVDA close above $140?",
					closesAt: "2026-07-31T00:00:00.000Z",
					volume: 900,
					symbol: "NVDA",
					matchKind: "direct_price",
				}),
				card({
					key: "price-b",
					title: "Will NVDA hit $200 in July?",
					closesAt: "2026-07-20T00:00:00.000Z",
					volume: 500,
					symbol: "NVDA",
					matchKind: "direct_price",
				}),
			],
			{ nowMs },
		);
		expect(selected).toEqual([]);
	});

	it("prefers daily up/down over sooner end-of-month price targets", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "month-price",
					title: "Will NVDA close above $140 by end of July?",
					closesAt: "2026-07-12T00:00:00.000Z",
					volume: 9000,
					symbol: "NVDA",
					matchKind: "direct_price",
				}),
				card({
					key: "up-down",
					title: "NVIDIA (NVDA) Up or Down on July 31?",
					closesAt: "2026-07-31T20:00:00.000Z",
					volume: 1200,
					symbol: "NVDA",
					matchKind: "direct_price",
					outcomes: upDownOutcomes(55, 45),
				}),
			],
			{ nowMs },
		);
		expect(selected.map((c) => c.key)).toEqual(["up-down"]);
	});

	it("on July 30 prefers July 31 up/down over today's still-open July 30 market", () => {
		// 2026-07-30 16:00 UTC = noon ET — July 30 session still open.
		const july30NoonEt = Date.parse("2026-07-30T16:00:00.000Z");
		const selected = selectAssetEventCards(
			[
				card({
					key: "today",
					title: "NVIDIA (NVDA) Up or Down on July 30?",
					closesAt: "2026-07-30T20:00:00.000Z",
					volume: 9000,
					symbol: "NVDA",
					matchKind: "direct_price",
					outcomes: upDownOutcomes(55, 45),
				}),
				card({
					key: "tomorrow",
					title: "NVIDIA (NVDA) Up or Down on July 31?",
					closesAt: "2026-07-31T20:00:00.000Z",
					volume: 1200,
					symbol: "NVDA",
					matchKind: "direct_price",
					outcomes: upDownOutcomes(52, 48),
				}),
				card({
					key: "week-out",
					title: "NVIDIA (NVDA) Up or Down on August 5?",
					closesAt: "2026-08-05T20:00:00.000Z",
					volume: 800,
					symbol: "NVDA",
					matchKind: "direct_price",
					outcomes: upDownOutcomes(50, 50),
				}),
			],
			{ nowMs: july30NoonEt },
		);
		expect(selected.map((c) => c.key)).toEqual(["tomorrow"]);
	});

	it("returns empty when only today's up/down and non-direction markets exist", () => {
		const july30NoonEt = Date.parse("2026-07-30T16:00:00.000Z");
		const selected = selectAssetEventCards(
			[
				card({
					key: "today",
					title: "NVIDIA (NVDA) Up or Down on July 30?",
					closesAt: "2026-07-30T20:00:00.000Z",
					volume: 9000,
					symbol: "NVDA",
					matchKind: "direct_price",
					outcomes: upDownOutcomes(55, 45),
				}),
				card({
					key: "subject",
					title: "NVDA earnings beat?",
					closesAt: "2026-08-01T00:00:00.000Z",
					volume: 2000,
					symbol: "NVDA",
					matchKind: "company_subject",
				}),
				card({
					key: "kpi",
					title: "Will Palantir report above 1060 total customers in Q2 2026?",
					closesAt: "2026-08-15T00:00:00.000Z",
					volume: 5000,
					symbol: "PLTR",
					matchKind: "kpi",
				}),
				card({
					key: "eom-updown",
					title: "SpaceX Closing Price Up/Down End of July?",
					closesAt: "2026-07-31T20:00:00.000Z",
					volume: 3000,
					symbol: "SPCX",
					matchKind: "company_subject",
				}),
			],
			{ nowMs: july30NoonEt },
		);
		expect(selected).toEqual([]);
	});

	it("returns empty for KPI and company-subject markets (no direction fallback)", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "price",
					title: "Will NVDA close above $150?",
					closesAt: "2026-07-14T00:00:00.000Z",
					volume: 800,
					symbol: "NVDA",
					matchKind: "direct_price",
				}),
				card({
					key: "subject",
					title: "Largest Company end of July?",
					closesAt: "2026-08-01T00:00:00.000Z",
					volume: 2000,
					symbol: "NVDA",
					matchKind: "company_subject",
				}),
				card({
					key: "ongoing",
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
			],
			{ nowMs },
		);
		expect(selected).toEqual([]);
	});

	it("omits stale next-day up/down snapshots older than 48h", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "stale",
					title: "NVIDIA (NVDA) Up or Down on July 15?",
					closesAt: "2026-07-15T20:00:00.000Z",
					refreshedAt: "2026-07-07T00:00:00.000Z",
					symbol: "NVDA",
					matchKind: "direct_price",
					outcomes: upDownOutcomes(55, 45),
				}),
			],
			{ nowMs },
		);
		expect(selected).toEqual([]);
	});

	it("never returns more than one card even when many NVDA markets match", () => {
		const flood = [
			card({
				key: "nvda-dated-a",
				title: "Will NVDA close above $140?",
				closesAt: "2026-07-18T00:00:00.000Z",
				volume: 900,
				symbol: "NVDA",
				matchKind: "direct_price",
			}),
			card({
				key: "nvda-dated-b",
				title: "Will NVDA close above $150?",
				closesAt: "2026-07-14T00:00:00.000Z",
				volume: 800,
				symbol: "NVDA",
				matchKind: "direct_price",
			}),
			card({
				key: "nvda-up-down",
				title: "NVIDIA (NVDA) Up or Down on July 15?",
				closesAt: "2026-07-15T20:00:00.000Z",
				volume: 500,
				symbol: "NVDA",
				matchKind: "direct_price",
				outcomes: upDownOutcomes(55, 45),
			}),
			card({
				key: "nvda-dated-c",
				title: "NVDA earnings beat?",
				closesAt: "2026-08-01T00:00:00.000Z",
				volume: 2000,
				symbol: "NVDA",
				matchKind: "company_subject",
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
		expect(selected[0]?.key).toBe("nvda-up-down");
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
