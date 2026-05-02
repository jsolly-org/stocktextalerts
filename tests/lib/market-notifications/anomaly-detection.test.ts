import { describe, expect, it } from "vitest";
import { computeAnomalyScore } from "../../../src/lib/market-notifications/anomaly-detection";
import type { AssetSnapshot } from "../../../src/lib/market-notifications/snapshot-store";
import type { ExtendedAssetQuote } from "../../../src/lib/providers/price-fetcher";

/** Defaults modeled on AAPL trading at ~$187 on a typical low-volatility day. */
function makeQuote(overrides: Partial<ExtendedAssetQuote> = {}): ExtendedAssetQuote {
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
function makeSnapshot(overrides: Partial<AssetSnapshot> = {}, minutesAgo = 0): AssetSnapshot {
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
	return Array.from({ length: count }, (_, i) => makeSnapshot({ price: basePrice }, count - i));
}

describe("computeAnomalyScore", () => {
	it("AAPL with only 3 snapshots collected so far returns insufficient data", () => {
		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(3),
			hasEarningsNearby: false,
		});

		expect(result.score).toBe(0);
		expect(result.summary).toContain("Insufficient data");
	});

	it("MRNA 5% move on a volatile 8% range day does NOT trigger (volatility normalization)", () => {
		const snapshots = makeSnapshots(10, 34.8).map((s) => ({
			...s,
			symbol: "MRNA",
			dayHigh: 37.58,
			dayLow: 34.8,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 36.54,
				dayHigh: 37.58,
				dayLow: 34.8,
				volume: null,
			}),
			snapshots,
			hasEarningsNearby: false,
		});

		expect(result.score).toBeLessThan(30);
	});

	it("AAPL 2% move on a tight 1.5% range day scores high (normalization amplifies)", () => {
		const snapshots = makeSnapshots(10, 187.42).map((s) => ({
			...s,
			dayHigh: 190.23,
			dayLow: 187.42,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 191.17,
				dayHigh: 191.17,
				dayLow: 187.42,
				volume: null,
			}),
			snapshots,
			hasEarningsNearby: false,
		});

		const priceSignal = result.signals.find((s) => s.name === "excess_price_move");
		expect(priceSignal?.points).toBeGreaterThan(0);
	});

	it("NVDA surge on high volume scores higher than same move on low volume", () => {
		const snapshots = makeSnapshots(10, 131.25).map((s) => ({
			...s,
			symbol: "NVDA",
			volume: 45_000_000,
			dayHigh: 133.18,
			dayLow: 130.5,
		}));

		const highVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 135.17,
				dayHigh: 135.17,
				dayLow: 130.5,
				volume: 67_500_000,
			}),
			snapshots,
			hasEarningsNearby: false,
			avgVolume20d: 22_500_000,
		});

		const lowVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 135.17,
				dayHigh: 135.17,
				dayLow: 130.5,
				volume: 22_500_000,
			}),
			snapshots,
			hasEarningsNearby: false,
			avgVolume20d: 22_500_000,
		});

		// High volume should produce a higher total score (both price + volume signals)
		expect(highVolResult.score).toBeGreaterThan(lowVolResult.score);
	});

	it("TSLA 10% crash with heavy volume produces high score via price + volume + breakout", () => {
		const snapshots = makeSnapshots(10, 248.5).map((s) => ({
			...s,
			symbol: "TSLA",
			dayHigh: 251.0,
			dayLow: 246.0,
			volume: 80_000_000,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 223.65,
				dayHigh: 251.0,
				dayLow: 223.65,
				volume: 160_000_000,
			}),
			snapshots,
			hasEarningsNearby: false,
			avgVolume20d: 50_000_000,
		});

		// Should score high with price, volume, and breakout all contributing
		expect(result.score).toBeGreaterThanOrEqual(45);
		const volumeSignal = result.signals.find((s) => s.name === "volume_confirmation");
		expect(volumeSignal?.points).toBeGreaterThan(0);
	});

	it("MSFT drops 6% with earnings tomorrow triggers even at extreme threshold", () => {
		const snapshots = makeSnapshots(10, 415.3).map((s) => ({
			...s,
			symbol: "MSFT",
			dayHigh: 419.45,
			dayLow: 411.2,
			volume: 22_000_000,
		}));

		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 390.38,
				dayHigh: 419.45,
				dayLow: 390.38,
				volume: 44_000_000,
			}),
			snapshots,
			hasEarningsNearby: true,
			avgVolume20d: 20_000_000,
		});

		// Price + volume + breakout + earnings should produce a notable score
		expect(result.score).toBeGreaterThanOrEqual(50);
	});

	it("SPY small breakout 0.5% above day high scores 1 pt, 2%+ breakout scores 15 pts", () => {
		const snapshotsSmall = makeSnapshots(10, 518.3).map((s) => ({
			...s,
			symbol: "SPY",
			dayHigh: 518.3,
			dayLow: 508.15,
		}));

		const smallResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 520.92,
				dayHigh: 520.92,
				dayLow: 508.15,
				volume: null,
			}),
			snapshots: snapshotsSmall,
			hasEarningsNearby: false,
		});
		const smallBreakout = smallResult.signals.find((s) => s.name === "range_breakout");
		expect(smallBreakout?.points).toBe(1);

		const snapshotsLarge = makeSnapshots(10, 518.3).map((s) => ({
			...s,
			symbol: "SPY",
			dayHigh: 518.3,
			dayLow: 508.15,
		}));

		const largeResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 528.67,
				dayHigh: 528.67,
				dayLow: 508.15,
				volume: null,
			}),
			snapshots: snapshotsLarge,
			hasEarningsNearby: false,
		});
		const largeBreakout = largeResult.signals.find((s) => s.name === "range_breakout");
		expect(largeBreakout?.points).toBe(15);
	});

	it("GOOGL 4% drop scores lower when Technology sector also dropped 3%", () => {
		const snapshots = makeSnapshots(10, 176.85).map((s) => ({
			...s,
			symbol: "GOOGL",
			dayHigh: 178.62,
			dayLow: 175.1,
			volume: 28_000_000,
		}));

		const quote = makeQuote({
			price: 169.78,
			changePercent: -4.0,
			dayHigh: 178.62,
			dayLow: 169.78,
			volume: 42_000_000,
		});

		const withoutBenchmark = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby: false,
		});

		const withSectorDown = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby: false,
			benchmarkMovePct: -3.0,
		});

		expect(withSectorDown.score).toBeLessThan(withoutBenchmark.score);
	});

	it("AAPL 3% drop scores the same when benchmark moved in opposite direction", () => {
		const snapshots = makeSnapshots(10, 187.42).map((s) => ({
			...s,
			dayHigh: 189.29,
			dayLow: 187.42,
		}));

		const quote = makeQuote({
			price: 181.79,
			changePercent: -3.0,
			dayHigh: 189.29,
			dayLow: 181.79,
			volume: null,
		});

		const withoutBenchmark = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby: false,
		});

		const withMarketUp = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby: false,
			benchmarkMovePct: 1.5,
		});

		expect(withMarketUp.score).toBe(withoutBenchmark.score);
	});

	it("AAPL with earnings in 2 days adds 15 pts for earnings proximity", () => {
		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(10),
			hasEarningsNearby: true,
		});

		const earningsSignal = result.signals.find((s) => s.name === "earnings_proximity");
		expect(earningsSignal?.points).toBe(15);
	});

	// --- New tests for the overhaul ---

	it("Volume signal: 3x RVOL surge with price move = notable points; surge with no move = 0", () => {
		const snapshots = makeSnapshots(10, 100).map((s) => ({
			...s,
			volume: 1_000_000,
			dayHigh: 101,
			dayLow: 99,
		}));

		// With price move (3% move, 3x volume)
		const withMove = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 103,
				dayHigh: 103,
				dayLow: 99,
				volume: 3_000_000,
			}),
			snapshots,
			hasEarningsNearby: false,
			avgVolume20d: 1_000_000,
		});
		const volSignal = withMove.signals.find((s) => s.name === "volume_confirmation");
		expect(volSignal?.points).toBeGreaterThan(5);

		// No price move (same price, 3x volume)
		const noMove = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 100.1,
				dayHigh: 101,
				dayLow: 99,
				volume: 3_000_000,
			}),
			snapshots,
			hasEarningsNearby: false,
			avgVolume20d: 1_000_000,
		});
		const noMoveVol = noMove.signals.find((s) => s.name === "volume_confirmation");
		expect(noMoveVol?.points).toBe(0);
	});

	it("ATR normalization: 5% move on stock with 8% ATR scores low; 2% move on 1% ATR scores high", () => {
		// High volatility stock: 5% move but ATR is 8%
		const highVolSnapshots = makeSnapshots(10, 100).map((s) => ({
			...s,
			dayHigh: 108,
			dayLow: 100,
		}));
		const highVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 105,
				dayHigh: 108,
				dayLow: 100,
				volume: null,
			}),
			snapshots: highVolSnapshots,
			hasEarningsNearby: false,
			atr14: 8, // $8 ATR on $100 stock = 8%
		});

		// Low volatility stock: 2% move but ATR is 1%
		const lowVolSnapshots = makeSnapshots(10, 100).map((s) => ({
			...s,
			dayHigh: 101,
			dayLow: 99.5,
		}));
		const lowVolResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 102,
				dayHigh: 102,
				dayLow: 99.5,
				volume: null,
			}),
			snapshots: lowVolSnapshots,
			hasEarningsNearby: false,
			atr14: 1, // $1 ATR on $100 stock = 1%
		});

		const highVolPrice = highVolResult.signals.find((s) => s.name === "excess_price_move");
		const lowVolPrice = lowVolResult.signals.find((s) => s.name === "excess_price_move");
		// 2% move on 1% ATR stock should score higher than 5% move on 8% ATR stock
		expect(lowVolPrice?.points).toBeGreaterThan(highVolPrice?.points ?? 0);
	});

	it("Excess move: GOOGL -4% with sector -3% scores much lower than GOOGL -4% sector flat", () => {
		const snapshots = makeSnapshots(10, 176.85).map((s) => ({
			...s,
			symbol: "GOOGL",
			dayHigh: 178.62,
			dayLow: 175.1,
			volume: 28_000_000,
		}));

		const quote = makeQuote({
			price: 169.78,
			dayHigh: 178.62,
			dayLow: 169.78,
			volume: 42_000_000,
		});

		const sectorFlat = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby: false,
			benchmarkMovePct: 0,
		});

		const sectorDown3 = computeAnomalyScore({
			currentQuote: quote,
			snapshots,
			hasEarningsNearby: false,
			benchmarkMovePct: -3.0,
		});

		const priceFlat = sectorFlat.signals.find((s) => s.name === "excess_price_move");
		const priceDown = sectorDown3.signals.find((s) => s.name === "excess_price_move");
		expect(priceFlat?.points).toBeGreaterThan(priceDown?.points ?? 0);
	});

	it("V-reversal: scanning all snapshots catches moves that oldest/latest would miss", () => {
		// Stock was at 100, dipped to 90 mid-window, now back at 100
		const snapshots: AssetSnapshot[] = [
			makeSnapshot({ price: 100 }, 60), // oldest
			makeSnapshot({ price: 98 }, 50),
			makeSnapshot({ price: 95 }, 40),
			makeSnapshot({ price: 90 }, 30), // trough
			makeSnapshot({ price: 93 }, 20),
			makeSnapshot({ price: 96 }, 10),
			makeSnapshot({ price: 99 }, 5), // latest
		];

		// Current price is 100 (same as oldest → sustained move = 0%)
		// But max move from trough (90) = 11.1%
		const result = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 100,
				dayHigh: 101,
				dayLow: 89,
				volume: null,
			}),
			snapshots,
			hasEarningsNearby: false,
		});

		const priceSignal = result.signals.find((s) => s.name === "excess_price_move");
		// Should detect the V-reversal (move from 90→100 = 11.1%)
		expect(priceSignal?.points).toBeGreaterThan(10);
	});

	it("Graceful degradation: no daily stats = uses snapshot-based fallbacks", () => {
		const snapshots = makeSnapshots(10, 100).map((s) => ({
			...s,
			volume: 1_000_000,
			dayHigh: 102,
			dayLow: 98,
		}));

		// Without daily stats
		const withoutStats = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 105,
				dayHigh: 105,
				dayLow: 98,
				volume: 2_000_000,
			}),
			snapshots,
			hasEarningsNearby: false,
		});

		// With daily stats
		const withStats = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 105,
				dayHigh: 105,
				dayLow: 98,
				volume: 2_000_000,
			}),
			snapshots,
			hasEarningsNearby: false,
			avgVolume20d: 1_000_000,
			atr14: 2,
		});

		// Both should produce non-zero scores
		expect(withoutStats.score).toBeGreaterThan(0);
		expect(withStats.score).toBeGreaterThan(0);
	});

	it("Early-day range breakout capped at 10 pts", () => {
		const snapshots = makeSnapshots(10, 518.3).map((s) => ({
			...s,
			dayHigh: 518.3,
			dayLow: 508.15,
		}));

		const normalResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 528.67,
				dayHigh: 528.67,
				dayLow: 508.15,
				volume: null,
			}),
			snapshots,
			hasEarningsNearby: false,
			isEarlyDay: false,
		});

		const earlyResult = computeAnomalyScore({
			currentQuote: makeQuote({
				price: 528.67,
				dayHigh: 528.67,
				dayLow: 508.15,
				volume: null,
			}),
			snapshots,
			hasEarningsNearby: false,
			isEarlyDay: true,
		});

		const normalBreakout = normalResult.signals.find((s) => s.name === "range_breakout");
		const earlyBreakout = earlyResult.signals.find((s) => s.name === "range_breakout");

		expect(normalBreakout?.points).toBe(15);
		expect(earlyBreakout?.points).toBeLessThanOrEqual(10);
	});

	it("has 4 signals with correct names when enough snapshots", () => {
		const result = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(10),
			hasEarningsNearby: false,
		});

		expect(result.signals).toHaveLength(4);
		const names = result.signals.map((s) => s.name);
		expect(names).toContain("excess_price_move");
		expect(names).toContain("volume_confirmation");
		expect(names).toContain("range_breakout");
		expect(names).toContain("earnings_proximity");
	});

	it("max possible score is 100", () => {
		const maxPoints = computeAnomalyScore({
			currentQuote: makeQuote(),
			snapshots: makeSnapshots(10),
			hasEarningsNearby: false,
		}).signals.reduce((sum, s) => sum + s.maxPoints, 0);
		expect(maxPoints).toBe(100);
	});
});
