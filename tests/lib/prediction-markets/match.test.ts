import { describe, expect, it } from "vitest";
import { validateEnrichedAliases } from "../../../src/lib/prediction-markets/alias-enrich";
import {
	buildAssetIdentity,
	buildDeterministicAliases,
	outcomeMatchesIdentity,
	polymarketSearchQueries,
	textHasIdentity,
} from "../../../src/lib/prediction-markets/aliases";
import { findIdentityEvidence, resolveMatchKind } from "../../../src/lib/prediction-markets/match";
import {
	rankDiscoveredEvents,
	selectDigestAssetMarkets,
} from "../../../src/lib/prediction-markets/rank";
import type { DiscoveredPredictionEvent } from "../../../src/lib/prediction-markets/types";

describe("buildDeterministicAliases", () => {
	it("includes ticker forms and GOOGL seed aliases", () => {
		const aliases = buildDeterministicAliases("GOOGL", "Alphabet Inc.");
		expect(aliases).toContain("GOOGL");
		expect(aliases).toContain("(GOOGL)");
		expect(aliases).toContain("Google");
		expect(aliases).toContain("Gemini");
	});
});

describe("textHasIdentity / SPY≠SPX", () => {
	const spy = buildAssetIdentity({ symbol: "SPY", name: "SPDR S&P 500 ETF Trust" });
	const bah = buildAssetIdentity({
		symbol: "BAH",
		name: "Booz Allen Hamilton Holding Corporation",
	});

	it("accepts SPY ETF context and rejects bare SPX", () => {
		expect(textHasIdentity("What will S&P 500 (SPY) hit in July?", spy).hit).toBe(true);
		expect(textHasIdentity("What will S&P 500 (SPX) hit by end of December?", spy).hit).toBe(false);
	});

	it("rejects Bahrain noise for BAH", () => {
		expect(
			textHasIdentity("Hamad bin Isa Al Khalifa out as leader of Bahrain by...?", bah).hit,
		).toBe(false);
		expect(textHasIdentity("Booz Allen wins contract", bah).hit).toBe(true);
	});
});

describe("findIdentityEvidence", () => {
	const googl = buildAssetIdentity({
		symbol: "GOOGL",
		name: "Alphabet Inc.",
		persistedAliases: ["Google", "Gemini"],
	});
	const tsla = buildAssetIdentity({ symbol: "TSLA", name: "Tesla, Inc." });

	it("matches outcome-leg company subjects", () => {
		const evidence = findIdentityEvidence(
			"Which company's AI will first hit 1550 on Chatbot Arena in 2026?",
			["OpenAI", "Google", "Anthropic"],
			googl,
		);
		expect(evidence).toEqual({ where: "outcome", alias: "Google" });
		expect(
			resolveMatchKind(
				"Which company's AI will first hit 1550 on Chatbot Arena in 2026?",
				evidence!,
			),
		).toBe("company_subject");
	});

	it("rejects company-less theme thresholds", () => {
		expect(
			findIdentityEvidence(
				"Will any AI model reach a Chatbot Arena score of at least 1600?",
				["↑ 1600", "↑ 1650"],
				googl,
			),
		).toBeNull();
	});

	it("prefers price over product hype for title classification", () => {
		const price = findIdentityEvidence(
			"What will Tesla, Inc. (TSLA) hit Week of July 6 2026?",
			[],
			tsla,
		);
		expect(price?.where).toBe("title");
		expect(
			resolveMatchKind(
				price ? "What will Tesla, Inc. (TSLA) hit Week of July 6 2026?" : "",
				price!,
			),
		).toBe("direct_price");
	});

	it("upgrades outcome-leg markets with strong price lexicon to direct_price", () => {
		const evidence = findIdentityEvidence(
			"Which company's stock price will close above $200?",
			["Google", "OpenAI"],
			googl,
		);
		expect(evidence).toEqual({ where: "outcome", alias: "Google" });
		expect(resolveMatchKind("Which company's stock price will close above $200?", evidence!)).toBe(
			"direct_price",
		);
	});

	it("rejects DELL tennis false positives via junk lexicon", () => {
		const dell = buildAssetIdentity({ symbol: "DELL", name: "Dell Technologies Inc." });
		expect(
			findIdentityEvidence("ITF Tokyo: Matthew Dellavedova vs Taiyo Yamanaka", [], dell),
		).toBeNull();
	});
});

describe("outcomeMatchesIdentity", () => {
	const googl = buildAssetIdentity({
		symbol: "GOOGL",
		name: "Alphabet Inc.",
		persistedAliases: ["Google"],
	});
	it("requires exact normalized outcome match", () => {
		expect(outcomeMatchesIdentity("Google", googl).hit).toBe(true);
		expect(outcomeMatchesIdentity("Google Cloud", googl).hit).toBe(false);
	});
});

describe("validateEnrichedAliases", () => {
	it("drops theme words, baseline duplicates, and collisions", () => {
		const accepted = validateEnrichedAliases({
			symbol: "GOOGL",
			suggested: ["Gemini", "AI", "cloud", "Waymo", "YouTube", "Tesla"],
			otherIdentityNormalized: new Set(["tesla"]),
		});
		// Gemini/DeepMind are already in the GOOGL deterministic seed — enrich only adds net-new.
		expect(accepted).not.toContain("Gemini");
		expect(accepted).toContain("Waymo");
		expect(accepted).toContain("YouTube");
		expect(accepted).not.toContain("AI");
		expect(accepted).not.toContain("cloud");
		expect(accepted).not.toContain("Tesla");
	});
});

describe("polymarketSearchQueries", () => {
	it("uses strict SPY queries", () => {
		const spy = buildAssetIdentity({ symbol: "SPY", name: "SPDR S&P 500 ETF Trust" });
		expect(polymarketSearchQueries(spy)).toEqual(["SPY stock", "(SPY)", "SPDR S&P 500"]);
	});
});

describe("rankDiscoveredEvents", () => {
	const base = {
		seriesId: null as string | null,
		title: "x",
		url: "https://example.com",
		shape: "binary" as const,
		shapeValidated: true,
		volume: 100,
		closesAt: null as string | null,
		confidence: 80,
		evidence: { where: "title" as const, alias: "NVDA" },
		highlightAlias: "NVDA",
		outcomes: [
			{
				venueContractId: "yes",
				label: "Yes",
				probabilityPercent: 50,
				sortOrder: 0,
				strikeValue: null,
				volume: 100,
			},
		],
	};

	it("orders by confidence then volume; optional limit truncates for tests", () => {
		const candidates: DiscoveredPredictionEvent[] = [
			{
				...base,
				venue: "polymarket",
				venueEventId: "c1",
				matchKind: "direct_price",
				title: "NVDA price",
				confidence: 90,
				volume: 50,
			},
			{
				...base,
				venue: "polymarket",
				venueEventId: "c2",
				matchKind: "direct_price",
				title: "NVDA price 2",
				confidence: 90,
				volume: 200,
			},
			{
				...base,
				venue: "kalshi",
				venueEventId: "KXNVDAA-1",
				seriesId: "KXNVDAA",
				matchKind: "kpi",
				title: "headcount 1",
				confidence: 70,
			},
		];
		const full = rankDiscoveredEvents(candidates);
		expect(full).toHaveLength(3);
		expect(full[0]?.venueEventId).toBe("c2");
		expect(full[1]?.venueEventId).toBe("c1");
		expect(full[2]?.venueEventId).toBe("KXNVDAA-1");
		const capped = rankDiscoveredEvents(candidates, 2);
		expect(capped).toHaveLength(2);
		expect(capped[0]?.venueEventId).toBe("c2");
		expect(capped[1]?.venueEventId).toBe("c1");
	});
});

describe("selectDigestAssetMarkets", () => {
	it("round-robins across symbols with caps (legacy helper)", () => {
		const bySymbol = new Map([
			[
				"NVDA",
				[
					{ symbol: "NVDA", id: "n1" },
					{ symbol: "NVDA", id: "n2" },
				],
			],
			[
				"TSLA",
				[
					{ symbol: "TSLA", id: "t1" },
					{ symbol: "TSLA", id: "t2" },
				],
			],
			["CMG", [{ symbol: "CMG", id: "c1" }]],
		]);
		const selected = selectDigestAssetMarkets(bySymbol, { perAsset: 2, globalCap: 4 });
		// Symbols are sorted alphabetically (CMG, NVDA, TSLA) before round-robin.
		expect(selected.map((s) => s.id)).toEqual(["c1", "n1", "t1", "n2"]);
	});
});
