import type { ExtendedAssetQuote } from "../providers/price-fetcher";
import type { AssetSnapshot } from "./snapshot-store";

/* =============
Configuration
============= */

const MIN_SNAPSHOTS = 5;

/** Minimum intraday range percentage to prevent early-day inflation. */
const RANGE_FLOOR_PCT = 0.3;

/** Minimum excess move required for volume signal to trigger. */
const VOLUME_GATE_PCT = 0.5;

/* =============
Types
============= */

export interface SignalBreakdown {
	name: string;
	points: number;
	maxPoints: number;
	triggered: boolean;
	detail: string;
}

export interface AnomalyResult {
	score: number;
	signals: SignalBreakdown[];
	summary: string;
}

/* =============
Signal Calculations
============= */

interface PriceSignalResult {
	signal: SignalBreakdown;
	rawMovePct: number;
	excessMovePct: number;
}

/**
 * Compute the excess price-move signal and raw/excess move metrics.
 *
 * Scans ALL snapshots for the max absolute move (catches V-reversals),
 * subtracts benchmark contribution when moving in the same direction,
 * and normalizes by ATR-14 (preferred) or intraday range with a floor.
 * Returns the signal plus rawMovePct and excessMovePct for use in volume gating.
 */
function computeExcessPriceMoveWithMetrics(
	currentQuote: ExtendedAssetQuote,
	snapshots: AssetSnapshot[],
	benchmarkMovePct: number | null | undefined,
	atr14: number | null | undefined,
): PriceSignalResult {
	const maxPoints = 50;

	// Scan all snapshots for max absolute move (catches V-reversals)
	let maxMovePct = 0;
	// Caller guarantees snapshots.length >= MIN_SNAPSHOTS before reaching here.
	const firstSnapshot = snapshots[0];
	let maxMoveRef = firstSnapshot ? firstSnapshot.price : 0;
	for (const snap of snapshots) {
		if (snap.price <= 0) continue;
		const movePct = Math.abs(((currentQuote.price - snap.price) / snap.price) * 100);
		if (movePct > maxMovePct) {
			maxMovePct = movePct;
			maxMoveRef = snap.price;
		}
	}

	const rawMovePct = maxMovePct;
	const referencePrice = maxMoveRef;

	// Compute signed move for benchmark comparison
	const signedMovePct =
		referencePrice > 0 ? ((currentQuote.price - referencePrice) / referencePrice) * 100 : 0;

	// Compute excess move: subtract benchmark contribution when same direction
	let excessMovePct = rawMovePct;
	let benchmarkDetail = "";
	if (benchmarkMovePct != null && Math.abs(signedMovePct) > 0) {
		const stockDir = Math.sign(signedMovePct);
		const benchDir = Math.sign(benchmarkMovePct);
		if (stockDir === benchDir) {
			// Subtract benchmark, but floor at 30% of stock move
			const explained = Math.min(Math.abs(benchmarkMovePct), Math.abs(signedMovePct));
			excessMovePct = Math.max(rawMovePct - explained, rawMovePct * 0.3);
			benchmarkDetail = `, benchmark ${benchmarkMovePct >= 0 ? "+" : ""}${benchmarkMovePct.toFixed(2)}%`;
		}
		// Opposite directions or no benchmark: full credit (no deduction)
	}

	// Normalize by ATR-14 percentage when available, else intraday range with floor
	let normalizationBase: number;
	if (atr14 != null && atr14 > 0 && currentQuote.price > 0) {
		normalizationBase = (atr14 / currentQuote.price) * 100;
	} else {
		const dayHigh = currentQuote.dayHigh ?? currentQuote.price;
		const dayLow = currentQuote.dayLow ?? currentQuote.price;
		// When price is at day's extreme (crash/surge), current range is self-inclusive
		// and caps normalizedMove at ~1. Use snapshot range instead to avoid self-limiting.
		const isAtExtreme =
			(dayLow > 0 && currentQuote.price <= dayLow * 1.001) ||
			(dayHigh > 0 && currentQuote.price >= dayHigh * 0.999);
		let intradayRangePct: number;
		if (isAtExtreme && snapshots.length > 0) {
			const snapHighs = snapshots.map((s) => s.dayHigh).filter((h): h is number => h != null);
			const snapLows = snapshots.map((s) => s.dayLow).filter((l): l is number => l != null);
			const rangeHigh = snapHighs.length > 0 ? Math.max(...snapHighs) : dayHigh;
			const rangeLow = snapLows.length > 0 ? Math.min(...snapLows) : dayLow;
			const denom = Math.min(rangeLow, currentQuote.price);
			intradayRangePct = denom > 0 ? ((rangeHigh - rangeLow) / denom) * 100 : 0;
		} else {
			intradayRangePct = dayLow > 0 ? ((dayHigh - dayLow) / dayLow) * 100 : 0;
		}
		normalizationBase = Math.max(intradayRangePct, RANGE_FLOOR_PCT);
	}
	const normalizedMove = excessMovePct / normalizationBase;

	const priceRatio = Math.min(normalizedMove / 2.0, 1.0);
	const points = Math.round(priceRatio * maxPoints);

	const direction = currentQuote.price >= referencePrice ? "up" : "down";
	const moveType = "max-snap";

	const signal: SignalBreakdown = {
		name: "excess_price_move",
		points,
		maxPoints,
		triggered: points > 0,
		detail: `${direction} ${rawMovePct.toFixed(2)}% (${moveType}, excess ${excessMovePct.toFixed(2)}%${benchmarkDetail})`,
	};
	return { signal, rawMovePct, excessMovePct };
}

/** Minimum fraction of trading day for RVOL baseline (avoids noisy RVOL at open). */
const RVOL_FRACTION_FLOOR = 0.05;

/**
 * Compute the volume confirmation signal (standalone).
 *
 * Uses time-of-day-adjusted RVOL: current cumulative volume vs expected volume
 * at this point in the session (avgVolume20d * fractionOfDayElapsed). This
 * correctly compares partial-day volume to a proportional baseline instead of
 * the full-day average, enabling the 2x threshold to trigger during morning hours.
 * Gated on excess move >= 0.5% to prevent volume-only triggers.
 */
function computeVolumeSignal(
	currentQuote: ExtendedAssetQuote,
	_snapshots: AssetSnapshot[],
	excessMovePct: number,
	avgVolume20d: number | null | undefined,
	fractionOfTradingDayElapsed: number,
): SignalBreakdown {
	const maxPoints = 20;

	// Gate: volume alone is not alertable
	if (excessMovePct < VOLUME_GATE_PCT) {
		return {
			name: "volume_confirmation",
			points: 0,
			maxPoints,
			triggered: false,
			detail: `move too small for volume signal (${excessMovePct.toFixed(2)}% < ${VOLUME_GATE_PCT}%)`,
		};
	}

	if (currentQuote.volume === null || currentQuote.volume <= 0) {
		return {
			name: "volume_confirmation",
			points: 0,
			maxPoints,
			triggered: false,
			detail: "no volume data",
		};
	}

	// Determine baseline: use ADV-20 only. A same-session snapshot median is not
	// comparable to daily volume and biases RVOL when daily stats are unavailable.
	const avgVolume = avgVolume20d;
	if (avgVolume == null || avgVolume <= 0) {
		return {
			name: "volume_confirmation",
			points: 0,
			maxPoints,
			triggered: false,
			detail: "no ADV-20 baseline",
		};
	}

	// Time-of-day adjustment: compare partial-day volume to expected volume at
	// this point in the session (linear approximation of intraday volume curve).
	const fraction = Math.max(fractionOfTradingDayElapsed, RVOL_FRACTION_FLOOR);
	const expectedVolumeAtTime = avgVolume * fraction;
	const rvol = currentQuote.volume / expectedVolumeAtTime;

	// Piecewise linear scaling aligned with industry RVOL thresholds
	let points: number;
	if (rvol < 2.0) {
		points = 0;
	} else if (rvol < 3.0) {
		// 2.0x–3.0x → 1–10 pts
		points = Math.round(1 + ((rvol - 2.0) / 1.0) * 9);
	} else if (rvol < 5.0) {
		// 3.0x–5.0x → 10–16 pts
		points = Math.round(10 + ((rvol - 3.0) / 2.0) * 6);
	} else {
		// 5.0x+ → 16–20 pts (log scale)
		// log2(5)=2.32, log2(10)=3.32, log2(20)=4.32
		const logPts = 16 + ((Math.log2(rvol) - Math.log2(5)) / (Math.log2(20) - Math.log2(5))) * 4;
		points = Math.round(Math.min(logPts, maxPoints));
	}

	points = Math.min(points, maxPoints);

	return {
		name: "volume_confirmation",
		points,
		maxPoints,
		triggered: points > 0,
		detail: `RVOL ${rvol.toFixed(1)}x`,
	};
}

/** Compute the range-breakout signal (high/low breakout vs recent intraday range). */
function computeRangeBreakout(
	currentPrice: number,
	snapshots: AssetSnapshot[],
	isEarlyDay?: boolean,
): SignalBreakdown {
	const fullMaxPoints = 15;
	// Cap at 10 pts before 10 AM ET (early-day noise reduction)
	const maxPoints = isEarlyDay ? 10 : fullMaxPoints;

	const dayHighs = snapshots.map((s) => s.dayHigh).filter((h): h is number => h !== null);
	const dayLows = snapshots.map((s) => s.dayLow).filter((l): l is number => l !== null);

	let highBreakoutPct = 0;
	if (dayHighs.length > 0) {
		const maxDayHigh = Math.max(...dayHighs);
		if (maxDayHigh > 0) {
			highBreakoutPct = Math.max(0, ((currentPrice - maxDayHigh) / maxDayHigh) * 100);
		}
	}

	let lowBreakoutPct = 0;
	if (dayLows.length > 0) {
		const minDayLow = Math.min(...dayLows);
		if (minDayLow > 0) {
			lowBreakoutPct = Math.max(0, ((minDayLow - currentPrice) / minDayLow) * 100);
		}
	}

	const breakoutPct = Math.max(highBreakoutPct, lowBreakoutPct);

	// Linear scale: 0.5% = 1 pt, 2.0% = max pts
	let points = 0;
	if (breakoutPct >= 0.5) {
		const ratio = Math.min((breakoutPct - 0.5) / (2.0 - 0.5), 1.0);
		points = Math.round(1 + ratio * (maxPoints - 1));
	}

	const direction = highBreakoutPct >= lowBreakoutPct ? "high" : "low";
	const triggered = points > 0;

	return {
		name: "range_breakout",
		points,
		maxPoints,
		triggered,
		detail: triggered
			? `${direction} breakout ${direction === "low" ? "-" : "+"}${breakoutPct.toFixed(2)}%${isEarlyDay ? " (early-day cap)" : ""}`
			: "within day range",
	};
}

/** Compute the earnings-proximity signal (binary within ~2 days). */
function computeEarningsProximity(hasEarningsNearby: boolean): SignalBreakdown {
	const maxPoints = 15;

	return {
		name: "earnings_proximity",
		points: hasEarningsNearby ? maxPoints : 0,
		maxPoints,
		triggered: hasEarningsNearby,
		detail: hasEarningsNearby ? "earnings within 2 days" : "no upcoming earnings",
	};
}

/* =============
Composite Scoring
============= */

/**
 * Compute the composite anomaly score for a symbol.
 *
 * 4 signals:
 *   - Regular hours max: 100 points
 *   - Before 10:00 AM ET: 95 points (range-breakout capped at 10)
 *   - Excess Price Move (50 pts): stock move beyond benchmark, normalized by ATR/range
 *   - Volume Confirmation (20 pts): standalone RVOL signal, gated on price move
 *   - Range Breakout (15 pts): session high/low breakout
 *   - Earnings Proximity (15 pts): binary if earnings within ~2 days
 */
export function computeAnomalyScore(options: {
	currentQuote: ExtendedAssetQuote;
	snapshots: AssetSnapshot[];
	hasEarningsNearby: boolean;
	/** Benchmark (sector ETF or SPY) percent move, signed. */
	benchmarkMovePct?: number | null;
	/** 20-day average daily volume for true RVOL (from daily_asset_stats). */
	avgVolume20d?: number | null;
	/** 14-day Average True Range in dollars (from daily_asset_stats). */
	atr14?: number | null;
	/** Whether current time is before 10 AM ET (early-day noise reduction). */
	isEarlyDay?: boolean;
	/** Fraction of trading session elapsed (0–1) for time-of-day RVOL adjustment. */
	fractionOfTradingDayElapsed?: number;
}): AnomalyResult {
	const {
		currentQuote,
		snapshots,
		hasEarningsNearby,
		benchmarkMovePct,
		avgVolume20d,
		atr14,
		isEarlyDay,
		fractionOfTradingDayElapsed = 1,
	} = options;

	// Need enough data to make meaningful comparisons
	if (snapshots.length < MIN_SNAPSHOTS) {
		return {
			score: 0,
			signals: [],
			summary: `Insufficient data (${snapshots.length}/${MIN_SNAPSHOTS} snapshots)`,
		};
	}

	const { signal: priceSignal, excessMovePct: excessForGate } = computeExcessPriceMoveWithMetrics(
		currentQuote,
		snapshots,
		benchmarkMovePct,
		atr14,
	);

	const volumeSignal = computeVolumeSignal(
		currentQuote,
		snapshots,
		excessForGate,
		avgVolume20d,
		fractionOfTradingDayElapsed,
	);

	const signals: SignalBreakdown[] = [
		priceSignal,
		volumeSignal,
		computeRangeBreakout(currentQuote.price, snapshots, isEarlyDay),
		computeEarningsProximity(hasEarningsNearby),
	];

	const score = signals.reduce((sum, s) => sum + s.points, 0);

	const triggeredSignals = signals.filter((s) => s.triggered);
	const summary =
		triggeredSignals.length > 0
			? triggeredSignals.map((s) => s.detail).join(", ")
			: "no significant signals";

	return { score, signals, summary };
}
