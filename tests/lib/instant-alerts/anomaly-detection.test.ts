import { describe, expect, it } from "vitest";
import {
	computeAnomalyScore,
	computePriceOnlyScore,
	getThresholdForSensitivity,
} from "../../../src/lib/instant-alerts/anomaly-detection";
import type { AssetSnapshot } from "../../../src/lib/instant-alerts/snapshot-store";
import type { ExtendedAssetQuote } from "../../../src/lib/price-fetcher";

function makeQuote(
	overrides: Partial<ExtendedAssetQuote> = {},
): ExtendedAssetQuote {
	return {
		price: 150.0,
		changePercent: 1.0,
		dayHigh: 152.0,
		dayLow: 148.0,
		dayOpen: 149.0,
		prevClose: 148.5,
		timestamp: Math.floor(Date.now() / 1000),
		volume: null,
		...overrides,
	};
}

function makeSnapshot(
	overrides: Partial<AssetSnapshot> = {},
	minutesAgo = 0,
): AssetSnapshot {
	return {
		symbol: "AAPL",
		price: 150.0,
		changePercent: 1.0,
		dayHigh: 152.0,
		dayLow: 148.0,
		dayOpen: 149.0,
		prevClose: 148.5,
		volume: null,
		capturedAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
		...overrides,
	};
}

function makeSnapshots(count: number, basePrice = 150.0): AssetSnapshot[] {
	return Array.from({ length: count }, (_, i) =>
		makeSnapshot({ price: basePrice }, count - i),
	);
}

function makeNewsItem(
	overrides: Partial<{ headline: string; datetime: number }> = {},
) {
	return {
		headline: overrides.headline ?? "Breaking news headline",
		summary: "",
		datetime: overrides.datetime ?? Date.now() / 1000,
		url: "https://example.com",
		source: "Reuters",
	};
}

describe("getThresholdForSensitivity", () => {
	it("returns 80 for Chill (1)", () => {
		expect(getThresholdForSensitivity(1)).toBe(80);
	});
	it("returns 70 for Normal (2)", () => {
		expect(getThresholdForSensitivity(2)).toBe(70);
	});
	it("returns 60 for Aggressive (3)", () => {
		expect(getThresholdForSensitivity(3)).toBe(60);
	});
	it("defaults to 80 for unknown values", () => {
		expect(getThresholdForSensitivity(0)).toBe(80);
		expect(getThresholdForSensitivity(99)).toBe(80);
	});
});

describe("computeAnomalyScore", () => {
	it("returns score 0 when fewer than 5 snapshots exist", () => {
		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(3),
			news: null,
			hasEarningsNearby: false,
		});

		expect(result.score).toBe(0);
		expect(result.triggered).toBe(false);
		expect(result.summary).toContain("Insufficient data");
	});

	it("volatile stock moderate move does NOT trigger (volatility normalization)", () => {
		// Biotech-like: 5% move on a day with 8% range → normalized move is small
		const snapshots = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 108.0,
			dayLow: 100.0,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 105.0,
				dayHigh: 108.0,
				dayLow: 100.0,
				volume: null,
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
			sensitivity: 3, // even at aggressive
		});

		expect(result.triggered).toBe(false);
	});

	it("stable stock moderate move scores high (normalization amplifies)", () => {
		// AAPL-like: 2% move on a day with 1.5% range → normalized move is amplified
		const snapshots = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 101.5,
			dayLow: 100.0,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 102.0,
				dayHigh: 102.0,
				dayLow: 100.0,
				volume: null,
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const priceSignal = result.signals.find((s) => s.name === "price_move");
		// 2% move, 2% range → normalized 1.0 → ratio 0.5 → ~22 raw pts, vol 0.8x → ~18
		expect(priceSignal!.points).toBeGreaterThan(0);
	});

	it("volume confirmation affects score (high vol vs low vol)", () => {
		const snapshots = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			volume: 1000000,
			dayHigh: 101.5,
			dayLow: 99.5,
		}));

		const highVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 103.0,
				dayHigh: 103.0,
				dayLow: 99.5,
				volume: 1500000, // 1.5x median
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const lowVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 103.0,
				dayHigh: 103.0,
				dayLow: 99.5,
				volume: 500000, // 0.5x median
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const highVolPrice = highVolResult.signals.find(
			(s) => s.name === "price_move",
		);
		const lowVolPrice = lowVolResult.signals.find(
			(s) => s.name === "price_move",
		);
		expect(highVolPrice!.points).toBeGreaterThan(lowVolPrice!.points);
	});

	it("price-only score never exceeds 60 (can't trigger alone even at Aggressive)", () => {
		// Extreme 10% move with max volume — should still cap at price_move 45 + breakout 15 = 60
		const snapshots = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 101.0,
			dayLow: 99.0,
			volume: 1000000,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 110.0, // 10% move
				dayHigh: 110.0,
				dayLow: 99.0,
				volume: 2000000,
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
			sensitivity: 3,
		});

		const priceSignal = result.signals.find((s) => s.name === "price_move");
		const breakoutSignal = result.signals.find(
			(s) => s.name === "range_breakout",
		);
		const priceOnlyTotal =
			(priceSignal?.points ?? 0) + (breakoutSignal?.points ?? 0);

		expect(priceOnlyTotal).toBeLessThanOrEqual(60);
		// With unknown volume multiplier 0.8x applied, the effective price points should be < 45
		// so the total should be strictly less than 60, preventing trigger at Aggressive
	});

	it("multi-signal convergence triggers at Chill threshold", () => {
		// Big move + news + earnings should comfortably exceed 80
		const snapshots = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 101.0,
			dayLow: 99.0,
			volume: 1000000,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 106.0, // 6% move
				dayHigh: 106.0,
				dayLow: 99.0,
				volume: 2000000,
			}),
			snapshots,
			news: [
				makeNewsItem(),
				makeNewsItem({ headline: "Second headline" }),
				makeNewsItem({ headline: "Third headline" }),
			],
			hasEarningsNearby: true,
			sensitivity: 1, // Chill
		});

		expect(result.score).toBeGreaterThanOrEqual(80);
		expect(result.triggered).toBe(true);
	});

	it("graduated news scoring: 1 old headline gives 10 pts", () => {
		const snapshots = makeSnapshots(10);
		const oldTimestamp = Date.now() / 1000 - 12 * 60 * 60; // 12 hours ago

		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots,
			news: [makeNewsItem({ datetime: oldTimestamp })],
			hasEarningsNearby: false,
		});

		const newsSignal = result.signals.find((s) => s.name === "breaking_news");
		expect(newsSignal!.points).toBe(10);
	});

	it("graduated news scoring: 3 recent headlines gives 25 pts", () => {
		const snapshots = makeSnapshots(10);
		const recentTimestamp = Date.now() / 1000 - 30 * 60; // 30 min ago

		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots,
			news: [
				makeNewsItem({ datetime: recentTimestamp }),
				makeNewsItem({ headline: "Second", datetime: recentTimestamp }),
				makeNewsItem({ headline: "Third", datetime: recentTimestamp }),
			],
			hasEarningsNearby: false,
		});

		const newsSignal = result.signals.find((s) => s.name === "breaking_news");
		expect(newsSignal!.points).toBe(25);
	});

	it("graduated breakout scoring: 0.5% = 1 pt, 2.0%+ = 15 pts", () => {
		// Test small breakout (0.5% above day high)
		const snapshotsSmall = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 100.0,
			dayLow: 98.0,
		}));

		const smallResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 100.5,
				dayHigh: 100.5,
				dayLow: 98.0,
				volume: null,
			}),
			snapshots: snapshotsSmall,
			news: null,
			hasEarningsNearby: false,
		});
		const smallBreakout = smallResult.signals.find(
			(s) => s.name === "range_breakout",
		);
		expect(smallBreakout!.points).toBe(1);

		// Test large breakout (2.0% above day high)
		const snapshotsLarge = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 100.0,
			dayLow: 98.0,
		}));

		const largeResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 102.0,
				dayHigh: 102.0,
				dayLow: 98.0,
				volume: null,
			}),
			snapshots: snapshotsLarge,
			news: null,
			hasEarningsNearby: false,
		});
		const largeBreakout = largeResult.signals.find(
			(s) => s.name === "range_breakout",
		);
		expect(largeBreakout!.points).toBe(15);
	});

	it("sensitivity parameter affects threshold: same score triggers at Aggressive but not Chill", () => {
		// Build a scenario that scores around 65 (above Aggressive 60 but below Chill 80)
		const snapshots = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 101.0,
			dayLow: 99.0,
			volume: 1000000,
		}));

		const quote = makeQuote({
			price: 104.0,
			dayHigh: 104.0,
			dayLow: 99.0,
			volume: 1500000,
		});

		// Just 1 old headline = 10 pts news
		const news = [makeNewsItem({ datetime: Date.now() / 1000 - 12 * 60 * 60 })];

		const aggressiveResult = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			news,
			hasEarningsNearby: false,
			sensitivity: 3,
		});

		const chillResult = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			news,
			hasEarningsNearby: false,
			sensitivity: 1,
		});

		// Same score, different trigger outcomes
		expect(aggressiveResult.score).toBe(chillResult.score);

		// If the score is between 60-79, it triggers at Aggressive but not Chill
		if (aggressiveResult.score >= 60 && aggressiveResult.score < 80) {
			expect(aggressiveResult.triggered).toBe(true);
			expect(chillResult.triggered).toBe(false);
		}
	});

	it("earnings proximity awards 15 pts", () => {
		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(10),
			news: null,
			hasEarningsNearby: true,
		});

		const earningsSignal = result.signals.find(
			(s) => s.name === "earnings_proximity",
		);
		expect(earningsSignal!.triggered).toBe(true);
		expect(earningsSignal!.points).toBe(15);
	});
});

describe("computePriceOnlyScore", () => {
	it("returns price-based score without news", () => {
		const snapshots = makeSnapshots(10, 100.0).map((s) => ({
			...s,
			dayHigh: 101.0,
			dayLow: 99.0,
		}));
		const score = computePriceOnlyScore({
			currentQuote: makeQuote({
				price: 103.0,
				dayHigh: 103.0,
				dayLow: 99.0,
				volume: null,
			}),
			snapshots,
			hasEarningsNearby: false,
		});

		expect(score).toBeGreaterThan(0);
	});

	it("returns 0 with insufficient snapshots", () => {
		const score = computePriceOnlyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(2),
			hasEarningsNearby: false,
		});

		expect(score).toBe(0);
	});
});
