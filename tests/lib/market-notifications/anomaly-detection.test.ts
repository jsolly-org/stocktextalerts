import { describe, expect, it } from "vitest";
import {
	computeAnomalyScore,
	computePriceOnlyScore,
} from "../../../src/lib/market-notifications/anomaly-detection";
import type { AssetSnapshot } from "../../../src/lib/market-notifications/snapshot-store";
import type { ExtendedAssetQuote } from "../../../src/lib/providers/price-fetcher";

/** Defaults modeled on AAPL trading at ~$187 on a typical low-volatility day. */
function makeQuote(
	overrides: Partial<ExtendedAssetQuote> = {},
): ExtendedAssetQuote {
	return {
		price: 187.42,
		changePercent: 0.83,
		dayHigh: 189.15,
		dayLow: 185.6,
		dayOpen: 186.1,
		prevClose: 185.87,
		timestamp: Math.floor(Date.now() / 1000),
		volume: null,
		...overrides,
	};
}

/** Defaults modeled on AAPL snapshot history at ~$187. */
function makeSnapshot(
	overrides: Partial<AssetSnapshot> = {},
	minutesAgo = 0,
): AssetSnapshot {
	return {
		symbol: "AAPL",
		price: 187.42,
		changePercent: 0.83,
		dayHigh: 189.15,
		dayLow: 185.6,
		dayOpen: 186.1,
		prevClose: 185.87,
		volume: null,
		capturedAt: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
		...overrides,
	};
}

function makeSnapshots(count: number, basePrice = 187.42): AssetSnapshot[] {
	return Array.from({ length: count }, (_, i) =>
		makeSnapshot({ price: basePrice }, count - i),
	);
}

function makeNewsItem(
	overrides: Partial<{ headline: string; datetime: number }> = {},
) {
	return {
		headline:
			overrides.headline ?? "Apple announces new AI features for iPhone",
		summary: "",
		datetime: overrides.datetime ?? Date.now() / 1000,
		url: "https://reuters.com/technology/apple-ai-features",
		source: "Reuters",
	};
}

describe("computeAnomalyScore", () => {
	it("AAPL with only 3 snapshots collected so far returns insufficient data", () => {
		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(3),
			news: null,
			hasEarningsNearby: false,
		});

		expect(result.score).toBe(0);
		expect(result.summary).toContain("Insufficient data");
	});

	it("MRNA 5% move on a volatile 8% range day does NOT trigger (volatility normalization)", () => {
		// Biotech like MRNA swings wide intraday — a 5% move within an 8% range is normal
		const snapshots = makeSnapshots(10, 34.8).map((s) => ({
			...s,
			symbol: "MRNA",
			dayHigh: 37.58, // 8% range above low
			dayLow: 34.8,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 36.54, // ~5% above snapshot base
				dayHigh: 37.58,
				dayLow: 34.8,
				volume: null,
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		// Low score because the move is small relative to the stock's own intraday range
		expect(result.score).toBeLessThan(25);
	});

	it("AAPL 2% move on a tight 1.5% range day scores high (normalization amplifies)", () => {
		// AAPL typically has narrow intraday range — a 2% move is unusual
		const snapshots = makeSnapshots(10, 187.42).map((s) => ({
			...s,
			dayHigh: 190.23, // ~1.5% range
			dayLow: 187.42,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 191.17, // ~2% above snapshot base
				dayHigh: 191.17,
				dayLow: 187.42,
				volume: null,
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const priceSignal = result.signals.find((s) => s.name === "price_move");
		// 2% move on 2% range → normalized 1.0 → ratio 0.5 → ~22 raw pts, vol 0.8x → ~18
		expect(priceSignal?.points).toBeGreaterThan(0);
	});

	it("NVDA surge on high volume scores higher than same move on low volume", () => {
		// NVDA averages ~45M shares/day; compare 1.5x spike vs 0.5x dry-up
		const snapshots = makeSnapshots(10, 131.25).map((s) => ({
			...s,
			symbol: "NVDA",
			volume: 45_000_000,
			dayHigh: 133.18, // ~1.5% range
			dayLow: 130.5,
		}));

		const highVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 135.17, // ~3% move
				dayHigh: 135.17,
				dayLow: 130.5,
				volume: 67_500_000, // 1.5x median
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const lowVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 135.17,
				dayHigh: 135.17,
				dayLow: 130.5,
				volume: 22_500_000, // 0.5x median
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
		expect(highVolPrice?.points).toBeGreaterThan(lowVolPrice?.points);
	});

	it("TSLA 10% crash with heavy volume still caps price-only score at 60", () => {
		// Even an extreme TSLA selloff can't trigger alerts on price alone — needs confirming signals
		const snapshots = makeSnapshots(10, 248.5).map((s) => ({
			...s,
			symbol: "TSLA",
			dayHigh: 251.0,
			dayLow: 246.0,
			volume: 80_000_000,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 223.65, // ~10% drop
				dayHigh: 251.0,
				dayLow: 223.65,
				volume: 160_000_000, // 2x median
			}),
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const priceSignal = result.signals.find((s) => s.name === "price_move");
		const breakoutSignal = result.signals.find(
			(s) => s.name === "range_breakout",
		);
		const priceOnlyTotal =
			(priceSignal?.points ?? 0) + (breakoutSignal?.points ?? 0);

		expect(priceOnlyTotal).toBeLessThanOrEqual(60);
	});

	it("MSFT drops 6% with earnings tomorrow and 3 headlines triggers even at very_large threshold", () => {
		// Multi-signal convergence: price crash + breaking news + upcoming earnings
		const snapshots = makeSnapshots(10, 415.3).map((s) => ({
			...s,
			symbol: "MSFT",
			dayHigh: 419.45,
			dayLow: 411.2,
			volume: 22_000_000,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 390.38, // ~6% drop
				dayHigh: 419.45,
				dayLow: 390.38,
				volume: 44_000_000, // 2x median
			}),
			snapshots,
			news: [
				makeNewsItem({
					headline: "Microsoft cloud revenue misses expectations",
				}),
				makeNewsItem({
					headline: "Azure growth slows amid enterprise spending pullback",
				}),
				makeNewsItem({
					headline: "Analysts downgrade MSFT ahead of earnings call",
				}),
			],
			hasEarningsNearby: true,
		});

		expect(result.score).toBeGreaterThanOrEqual(80);
	});

	it("AAPL morning headline published 12 hours ago scores 10 pts for stale news", () => {
		const snapshots = makeSnapshots(10);
		const oldTimestamp = Date.now() / 1000 - 12 * 60 * 60; // 12 hours ago

		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots,
			news: [
				makeNewsItem({
					headline: "Apple supplier warns of component shortage",
					datetime: oldTimestamp,
				}),
			],
			hasEarningsNearby: false,
		});

		const newsSignal = result.signals.find((s) => s.name === "breaking_news");
		expect(newsSignal?.points).toBe(10);
	});

	it("3 recent NVDA headlines within 30 minutes scores max 25 pts for breaking news", () => {
		const snapshots = makeSnapshots(10);
		const recentTimestamp = Date.now() / 1000 - 30 * 60; // 30 min ago

		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots,
			news: [
				makeNewsItem({
					headline: "NVIDIA unveils next-gen GPU architecture",
					datetime: recentTimestamp,
				}),
				makeNewsItem({
					headline: "Jensen Huang keynote drives NVDA to session highs",
					datetime: recentTimestamp,
				}),
				makeNewsItem({
					headline: "Analysts raise NVDA price targets after product launch",
					datetime: recentTimestamp,
				}),
			],
			hasEarningsNearby: false,
		});

		const newsSignal = result.signals.find((s) => s.name === "breaking_news");
		expect(newsSignal?.points).toBe(25);
	});

	it("SPY small breakout 0.5% above day high scores 1 pt, 2%+ breakout scores 15 pts", () => {
		// Small breakout: SPY edges just above session high
		const snapshotsSmall = makeSnapshots(10, 518.3).map((s) => ({
			...s,
			symbol: "SPY",
			dayHigh: 518.3,
			dayLow: 508.15,
		}));

		const smallResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 520.92, // ~0.5% above day high
				dayHigh: 520.92,
				dayLow: 508.15,
				volume: null,
			}),
			snapshots: snapshotsSmall,
			news: null,
			hasEarningsNearby: false,
		});
		const smallBreakout = smallResult.signals.find(
			(s) => s.name === "range_breakout",
		);
		expect(smallBreakout?.points).toBe(1);

		// Large breakout: SPY surges 2%+ above session high
		const snapshotsLarge = makeSnapshots(10, 518.3).map((s) => ({
			...s,
			symbol: "SPY",
			dayHigh: 518.3,
			dayLow: 508.15,
		}));

		const largeResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 528.67, // ~2% above day high
				dayHigh: 528.67,
				dayLow: 508.15,
				volume: null,
			}),
			snapshots: snapshotsLarge,
			news: null,
			hasEarningsNearby: false,
		});
		const largeBreakout = largeResult.signals.find(
			(s) => s.name === "range_breakout",
		);
		expect(largeBreakout?.points).toBe(15);
	});

	it("GOOGL 4% drop scores lower when Technology sector also dropped 3%", () => {
		// When the whole sector is down, the stock's move is less anomalous
		const snapshots = makeSnapshots(10, 176.85).map((s) => ({
			...s,
			symbol: "GOOGL",
			dayHigh: 178.62,
			dayLow: 175.1,
			volume: 28_000_000,
		}));

		const quote = makeQuote({
			price: 169.78, // ~4% drop
			changePercent: -4.0,
			dayHigh: 178.62,
			dayLow: 169.78,
			volume: 42_000_000, // 1.5x median
		});

		const withoutBenchmark = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const withSectorDown = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			news: null,
			hasEarningsNearby: false,
			benchmarkMovePct: -3.0, // sector dropped 3% too
		});

		// Score should be lower when sector explains much of the move
		expect(withSectorDown.score).toBeLessThan(withoutBenchmark.score);
	});

	it("AAPL 3% drop scores the same when benchmark moved in opposite direction", () => {
		// Stock drops while market rallies — not dampened, it's contrarian
		const snapshots = makeSnapshots(10, 187.42).map((s) => ({
			...s,
			dayHigh: 189.29,
			dayLow: 187.42,
		}));

		const quote = makeQuote({
			price: 181.79, // ~3% drop
			changePercent: -3.0,
			dayHigh: 189.29,
			dayLow: 181.79,
			volume: null,
		});

		const withoutBenchmark = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			news: null,
			hasEarningsNearby: false,
		});

		const withMarketUp = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			news: null,
			hasEarningsNearby: false,
			benchmarkMovePct: 1.5, // market is UP while stock is DOWN
		});

		// No dampening when directions differ
		expect(withMarketUp.score).toBe(withoutBenchmark.score);
	});

	it("AAPL with earnings in 2 days adds 15 pts for earnings proximity", () => {
		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(10),
			news: null,
			hasEarningsNearby: true,
		});

		const earningsSignal = result.signals.find(
			(s) => s.name === "earnings_proximity",
		);
		expect(earningsSignal?.points).toBe(15);
	});
});

describe("computePriceOnlyScore", () => {
	it("AAPL 3% move with no news still produces a non-zero price score", () => {
		const snapshots = makeSnapshots(10, 187.42).map((s) => ({
			...s,
			dayHigh: 189.29, // ~1% range
			dayLow: 187.42,
		}));
		const score = computePriceOnlyScore({
			currentQuote: makeQuote({
				price: 193.04, // ~3% move
				dayHigh: 193.04,
				dayLow: 187.42,
				volume: null,
			}),
			snapshots,
			hasEarningsNearby: false,
		});

		expect(score).toBeGreaterThan(0);
	});

	it("AAPL with only 2 snapshots returns 0 due to insufficient data", () => {
		const score = computePriceOnlyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(2),
			hasEarningsNearby: false,
		});

		expect(score).toBe(0);
	});
});
