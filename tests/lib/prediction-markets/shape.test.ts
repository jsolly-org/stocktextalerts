import { describe, expect, it } from "vitest";
import {
	compressEventOutcomes,
	detectPredictionMarketShape,
	ensureBinaryOutcomes,
	extractStrikeValue,
} from "../../../src/lib/prediction-markets/shape";
import type { PredictionMarketOutcome } from "../../../src/lib/prediction-markets/types";

describe("detectPredictionMarketShape", () => {
	it("classifies Yes/No pairs as binary", () => {
		const result = detectPredictionMarketShape({
			outcomes: [
				{
					venueContractId: "1",
					label: "Yes",
					probabilityPercent: 40,
					sortOrder: 0,
					strikeValue: null,
					volume: 1,
				},
				{
					venueContractId: "2",
					label: "No",
					probabilityPercent: 60,
					sortOrder: 1,
					strikeValue: null,
					volume: 1,
				},
			],
		});
		expect(result).toEqual({ shape: "binary", validated: true });
	});

	it("classifies ordered strike ladders as threshold", () => {
		const result = detectPredictionMarketShape({
			outcomes: [
				{
					venueContractId: "a",
					label: "Above $100",
					probabilityPercent: 80,
					sortOrder: 0,
					strikeValue: 100,
					volume: 1,
				},
				{
					venueContractId: "b",
					label: "Above $120",
					probabilityPercent: 55,
					sortOrder: 1,
					strikeValue: 120,
					volume: 1,
				},
				{
					venueContractId: "c",
					label: "Above $140",
					probabilityPercent: 30,
					sortOrder: 2,
					strikeValue: 140,
					volume: 1,
				},
			],
		});
		expect(result.shape).toBe("threshold");
		expect(result.validated).toBe(true);
	});

	it("classifies negRisk fields totaling ~100% as exclusive", () => {
		const result = detectPredictionMarketShape({
			negRisk: true,
			outcomes: [
				{
					venueContractId: "g",
					label: "Google",
					probabilityPercent: 12,
					sortOrder: 0,
					strikeValue: null,
					volume: 1,
				},
				{
					venueContractId: "o",
					label: "OpenAI",
					probabilityPercent: 40,
					sortOrder: 1,
					strikeValue: null,
					volume: 1,
				},
				{
					venueContractId: "a",
					label: "Anthropic",
					probabilityPercent: 48,
					sortOrder: 2,
					strikeValue: null,
					volume: 1,
				},
			],
		});
		expect(result).toEqual({ shape: "exclusive", validated: true });
	});

	it("falls back to independent when exclusivity is unvalidated", () => {
		const result = detectPredictionMarketShape({
			outcomes: [
				{
					venueContractId: "1",
					label: "Option A",
					probabilityPercent: 30,
					sortOrder: 0,
					strikeValue: null,
					volume: 1,
				},
				{
					venueContractId: "2",
					label: "Option B",
					probabilityPercent: 40,
					sortOrder: 1,
					strikeValue: null,
					volume: 1,
				},
			],
		});
		expect(result.shape).toBe("independent");
		expect(result.validated).toBe(false);
	});
});

describe("ensureBinaryOutcomes", () => {
	it("synthesizes No from a single Yes probability", () => {
		const out = ensureBinaryOutcomes(
			[
				{
					venueContractId: "c1",
					label: "Yes",
					probabilityPercent: 35,
					sortOrder: 0,
					strikeValue: null,
					volume: 10,
				},
			],
			"evt",
		);
		expect(out).toHaveLength(2);
		expect(out[0]?.label).toBe("Yes");
		expect(out[0]?.probabilityPercent).toBe(35);
		expect(out[1]?.label).toBe("No");
		expect(out[1]?.probabilityPercent).toBe(65);
	});
});

describe("extractStrikeValue", () => {
	it("parses dollar and percent strikes", () => {
		expect(extractStrikeValue("Above $140")).toBe(140);
		expect(extractStrikeValue("Above $1.2k")).toBe(1200);
		expect(extractStrikeValue("Fed cuts 25%")).toBe(25);
	});
});

describe("compressEventOutcomes", () => {
	const manyExclusive: PredictionMarketOutcome[] = Array.from({ length: 8 }, (_, i) => ({
		venueContractId: `o${i}`,
		label: i === 5 ? "Google" : `Option ${i}`,
		probabilityPercent: 20 - i,
		sortOrder: i,
		strikeValue: null,
		volume: 1,
		highlighted: i === 5,
	}));

	it("exclusive long fields show top four + force-include + Others mass", () => {
		const body = compressEventOutcomes({
			shape: "exclusive",
			shapeValidated: true,
			outcomes: manyExclusive,
			highlightAlias: "Google",
		});
		const others = body.rows.find((r) => r.kind === "others");
		expect(others?.kind).toBe("others");
		if (others?.kind === "others") {
			expect(others.omittedCount).toBeGreaterThan(0);
			expect(others.probabilityPercent).toBeGreaterThan(0);
		}
		expect(body.rows.some((r) => r.kind === "outcome" && r.label === "Google")).toBe(true);
	});

	it("independent never aggregates omitted probabilities", () => {
		const body = compressEventOutcomes({
			shape: "independent",
			shapeValidated: false,
			outcomes: manyExclusive,
			highlightAlias: "Google",
		});
		expect(body.rows.some((r) => r.kind === "others")).toBe(false);
		expect(body.rows.some((r) => r.kind === "more")).toBe(true);
		expect(body.footnote).toMatch(/do not sum/i);
	});

	it("threshold keeps strike order around the 50% crossover", () => {
		const ladder: PredictionMarketOutcome[] = [
			{
				venueContractId: "1",
				label: "$80",
				probabilityPercent: 90,
				sortOrder: 0,
				strikeValue: 80,
				volume: 1,
			},
			{
				venueContractId: "2",
				label: "$100",
				probabilityPercent: 70,
				sortOrder: 1,
				strikeValue: 100,
				volume: 1,
			},
			{
				venueContractId: "3",
				label: "$120",
				probabilityPercent: 45,
				sortOrder: 2,
				strikeValue: 120,
				volume: 1,
			},
			{
				venueContractId: "4",
				label: "$140",
				probabilityPercent: 25,
				sortOrder: 3,
				strikeValue: 140,
				volume: 1,
			},
			{
				venueContractId: "5",
				label: "$160",
				probabilityPercent: 10,
				sortOrder: 4,
				strikeValue: 160,
				volume: 1,
			},
		];
		const body = compressEventOutcomes({
			shape: "threshold",
			shapeValidated: true,
			outcomes: ladder,
			highlightAlias: null,
		});
		const labels = body.rows
			.filter((r) => r.kind === "outcome")
			.map((r) => (r.kind === "outcome" ? r.label : ""));
		expect(labels).toEqual(["$80", "$100", "$120", "$140"]);
		expect(body.linkLabel).toMatch(/5 strikes/);
		expect(body.footnote).toMatch(/midpoint/i);
	});
});
