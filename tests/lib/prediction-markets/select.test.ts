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
				venueContractId: "up",
				label: "Up",
				probabilityPercent: 55,
				sortOrder: 0,
				strikeValue: null,
				volume: 1,
			},
			{
				venueContractId: "down",
				label: "Down",
				probabilityPercent: 45,
				sortOrder: 1,
				strikeValue: null,
				volume: 1,
			},
		],
		...partial,
	};
}

describe("selectAssetEventCards", () => {
	const nowMs = Date.parse("2026-07-10T12:00:00.000Z");

	it("returns empty when only non-up/down markets exist", () => {
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
					key: "subject",
					title: "NVDA earnings beat?",
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
					matchKind: "company_subject",
				}),
			],
			{ nowMs },
		);
		expect(selected).toEqual([]);
	});

	it("picks only the soonest fresh up/down market and rejects expired", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "expired",
					title: "NVIDIA (NVDA) Up or Down on July 1?",
					closesAt: "2026-07-01T00:00:00.000Z",
					symbol: "NVDA",
				}),
				card({
					key: "late",
					title: "NVIDIA (NVDA) Up or Down on September 1?",
					closesAt: "2026-09-01T00:00:00.000Z",
					symbol: "NVDA",
				}),
				card({
					key: "soon",
					title: "NVIDIA (NVDA) Up or Down on July 15?",
					closesAt: "2026-07-15T00:00:00.000Z",
					symbol: "NVDA",
				}),
				card({
					key: "sooner",
					title: "NVIDIA (NVDA) Up or Down on July 12?",
					closesAt: "2026-07-12T00:00:00.000Z",
					symbol: "NVDA",
				}),
			],
			{ nowMs },
		);
		expect(selected.map((c) => c.key)).toEqual(["sooner"]);
	});

	it("omits stale up/down snapshots older than 48h", () => {
		const selected = selectAssetEventCards(
			[
				card({
					key: "stale",
					title: "NVIDIA (NVDA) Up or Down on August 1?",
					closesAt: "2026-08-01T00:00:00.000Z",
					refreshedAt: "2026-07-07T00:00:00.000Z",
					symbol: "NVDA",
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
				key: "nvda-up-down-late",
				title: "NVIDIA (NVDA) Up or Down on July 20?",
				closesAt: "2026-07-20T20:00:00.000Z",
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
			}),
			card({
				key: "nvda-dated-c",
				title: "NVDA earnings beat?",
				closesAt: "2026-08-01T00:00:00.000Z",
				volume: 2000,
				symbol: "NVDA",
				matchKind: "company_subject",
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
			["AAPL", [card({ key: "a", title: "Apple (AAPL) Up or Down on July 31?", symbol: "AAPL" })]],
			["NVDA", [card({ key: "n", title: "NVIDIA (NVDA) Up or Down on July 31?", symbol: "NVDA" })]],
		]);
		const ordered = orderCardsByWatchlist(bySymbol, ["NVDA", "AAPL"]);
		expect(ordered.map((c) => c.symbol)).toEqual(["NVDA", "AAPL"]);
	});
});
