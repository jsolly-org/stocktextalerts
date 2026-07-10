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

	it("picks the two soonest future closes and rejects expired", () => {
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
		expect(selected.map((c) => c.key)).toEqual(["sooner", "soon"]);
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

	it("adds undated ongoing cards when volume beats same-venue dated median", () => {
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
					key: "quiet",
					title: "Quiet Google rumor",
					closesAt: null,
					volume: 50,
					symbol: "GOOGL",
				}),
			],
			{ nowMs },
		);
		expect(selected.map((c) => c.key)).toEqual(["d1", "d2", "ongoing"]);
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
