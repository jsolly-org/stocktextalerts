import { describe, expect, it } from "vitest";
import {
	assertStructuredBinaryCard,
	isStructuredBinaryCard,
} from "../../../src/lib/prediction-markets/binary";
import type { PredictionMarketEventCard } from "../../../src/lib/prediction-markets/types";

function card(
	partial: Partial<PredictionMarketEventCard> & Pick<PredictionMarketEventCard, "key" | "outcomes">,
): PredictionMarketEventCard {
	return {
		title: partial.key,
		venue: "polymarket",
		url: "https://example.com",
		shape: "binary",
		shapeValidated: true,
		closesAt: null,
		refreshedAt: new Date().toISOString(),
		volume: 1,
		...partial,
	};
}

describe("isStructuredBinaryCard", () => {
	it("accepts Yes/No totaling ~100", () => {
		expect(
			isStructuredBinaryCard(
				card({
					key: "yn",
					outcomes: [
						{
							venueContractId: "y",
							label: "Yes",
							probabilityPercent: 12.5,
							sortOrder: 0,
							strikeValue: null,
							volume: 0,
						},
						{
							venueContractId: "n",
							label: "No",
							probabilityPercent: 87.5,
							sortOrder: 1,
							strikeValue: null,
							volume: 0,
						},
					],
				}),
			),
		).toBe(true);
	});

	it("accepts Up/Down totaling ~100", () => {
		const upDown = card({
			key: "ud",
			outcomes: [
				{
					venueContractId: "u",
					label: "Up",
					probabilityPercent: 60,
					sortOrder: 0,
					strikeValue: null,
					volume: 0,
				},
				{
					venueContractId: "d",
					label: "Down",
					probabilityPercent: 40,
					sortOrder: 1,
					strikeValue: null,
					volume: 0,
				},
			],
		});
		expect(isStructuredBinaryCard(upDown)).toBe(true);
		expect(() => assertStructuredBinaryCard(upDown)).not.toThrow();
	});

	it("rejects non-binary labels and bad totals", () => {
		expect(
			isStructuredBinaryCard(
				card({
					key: "maybe",
					outcomes: [
						{
							venueContractId: "a",
							label: "Maybe",
							probabilityPercent: 50,
							sortOrder: 0,
							strikeValue: null,
							volume: 0,
						},
						{
							venueContractId: "b",
							label: "No",
							probabilityPercent: 50,
							sortOrder: 1,
							strikeValue: null,
							volume: 0,
						},
					],
				}),
			),
		).toBe(false);

		expect(
			isStructuredBinaryCard(
				card({
					key: "skew",
					outcomes: [
						{
							venueContractId: "y",
							label: "Yes",
							probabilityPercent: 10,
							sortOrder: 0,
							strikeValue: null,
							volume: 0,
						},
						{
							venueContractId: "n",
							label: "No",
							probabilityPercent: 10,
							sortOrder: 1,
							strikeValue: null,
							volume: 0,
						},
					],
				}),
			),
		).toBe(false);
	});
});
