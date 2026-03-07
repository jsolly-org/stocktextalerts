import type { ExtendedAssetQuote } from "../providers/price-fetcher";
import type { AssetSnapshot } from "./snapshot-store";

/* =============
Configuration
============= */

const MIN_SNAPSHOTS = 5;

/** Volume multiplier when volume data is unavailable (penalizes missing data). */
const UNKNOWN_VOLUME_MULTIPLIER = 0.8;

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

/** Estimate median volume from snapshots (or `null` when unavailable). */
function estimateMedianVolume(snapshots: AssetSnapshot[]): number | null {
	const volumes = snapshots
		.map((s) => s.volume)
		.filter((v): v is number => v !== null && v > 0);

	if (volumes.length === 0) return null;

	volumes.sort((a, b) => a - b);
	const mid = Math.floor(volumes.length / 2);
	return volumes.length % 2 === 0
		? (volumes[mid - 1] + volumes[mid]) / 2
		: volumes[mid];
}

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
	avgVolume20d: number | null | undefined,
	atr14: number | null | undefined,
): PriceSignalResult {
	const maxPoints = 50;

	// Scan all snapshots for max absolute move (catches V-reversals)
	let maxMovePct = 0;
	let maxMoveRef = snapshots[0].price;
	for (const snap of snapshots) {
		if (snap.price <= 0) continue;
		const movePct = Math.abs(
			((currentQuote.price - snap.price) / snap.price) * 100,
		);
		if (movePct > maxMovePct) {
			maxMovePct = movePct;
			maxMoveRef = snap.price;
		}
	}

	// Also check sustained move (oldest → current)
	const oldest = snapshots[0];
	const sustainedMovePct =
		oldest.price > 0
			? Math.abs(((currentQuote.price - oldest.price) / oldest.price) * 100)
			: 0;

	const rawMovePct = Math.max(maxMovePct, sustainedMovePct);
	const referencePrice =
		maxMovePct >= sustainedMovePct ? maxMoveRef : oldest.price;

	// Compute signed move for benchmark comparison
	const signedMovePct =
		referencePrice > 0
			? ((currentQuote.price - referencePrice) / referencePrice) * 100
			: 0;

	// Compute excess move: subtract benchmark contribution when same direction
	let excessMovePct = rawMovePct;
	let benchmarkDetail = "";
	if (benchmarkMovePct != null && Math.abs(signedMovePct) > 0) {
		const stockDir = Math.sign(signedMovePct);
		const benchDir = Math.sign(benchmarkMovePct);
		if (stockDir === benchDir) {
			// Subtract benchmark, but floor at 30% of stock move
			const explained = Math.min(
				Math.abs(benchmarkMovePct),
				Math.abs(signedMovePct),
			);
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
		const intradayRangePct =
			dayLow > 0 ? ((dayHigh - dayLow) / dayLow) * 100 : 0;
		normalizationBase = Math.max(intradayRangePct, RANGE_FLOOR_PCT);
	}
	const normalizedMove =
		excessMovePct / Math.max(normalizationBase, RANGE_FLOOR_PCT);

	// Mild volume adjustment (0.7x–1.3x): light confirmation
	const medianVolume = estimateMedianVolume(snapshots);
	let volumeMultiplier = UNKNOWN_VOLUME_MULTIPLIER;
	if (currentQuote.volume !== null && currentQuote.volume > 0) {
		const baseline = avgVolume20d ?? medianVolume;
		if (baseline !== null && baseline > 0) {
			const volRatio = currentQuote.volume / baseline;
			volumeMultiplier = Math.max(0.7, Math.min(volRatio, 1.3));
		}
	}

	const priceRatio = Math.min(normalizedMove / 2.0, 1.0);
	const rawPts = Math.round(priceRatio * maxPoints);
	const points = Math.min(Math.round(rawPts * volumeMultiplier), maxPoints);

	const direction = currentQuote.price >= referencePrice ? "up" : "down";
	const moveType = maxMovePct >= sustainedMovePct ? "max-snap" : "sustained";

	const signal: SignalBreakdown = {
		name: "excess_price_move",
		points,
		maxPoints,
		triggered: points > 0,
		detail: `${direction} ${rawMovePct.toFixed(2)}% (${moveType}, excess ${excessMovePct.toFixed(2)}%, vol ${volumeMultiplier.toFixed(1)}x${benchmarkDetail})`,
	};
	return { signal, rawMovePct, excessMovePct };
}

/**
 * Compute the volume confirmation signal (standalone).
 *
 * Uses RVOL (current volume / 20-day average) with piecewise scaling.
 * Gated on excess move >= 0.5% to prevent volume-only triggers.
 */
function computeVolumeSignal(
	currentQuote: ExtendedAssetQuote,
	snapshots: AssetSnapshot[],
	excessMovePct: number,
	avgVolume20d: number | null | undefined,
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

	// Determine baseline: prefer ADV-20, fall back to median snapshot volume
	const baseline = avgVolume20d ?? estimateMedianVolume(snapshots);
	if (baseline === null || baseline <= 0) {
		return {
			name: "volume_confirmation",
			points: 0,
			maxPoints,
			triggered: false,
			detail: "no volume baseline",
		};
	}

	const rvol = currentQuote.volume / baseline;

	// Piecewise linear scaling aligned with industry RVOL thresholds
	let points: number;
	if (rvol < 1.0) {
		points = 0;
	} else if (rvol < 1.5) {
		// 1.0x–1.5x → 0–3 pts
		points = Math.round(((rvol - 1.0) / 0.5) * 3);
	} else if (rvol < 3.0) {
		// 1.5x–3.0x → 3–10 pts
		points = Math.round(3 + ((rvol - 1.5) / 1.5) * 7);
	} else if (rvol < 5.0) {
		// 3.0x–5.0x → 10–16 pts
		points = Math.round(10 + ((rvol - 3.0) / 2.0) * 6);
	} else {
		// 5.0x+ → 16–20 pts (log scale)
		// log2(5)=2.32, log2(10)=3.32, log2(20)=4.32
		const logPts =
			16 +
			((Math.log2(rvol) - Math.log2(5)) / (Math.log2(20) - Math.log2(5))) * 4;
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

	const dayHighs = snapshots
		.map((s) => s.dayHigh)
		.filter((h): h is number => h !== null);
	const dayLows = snapshots
		.map((s) => s.dayLow)
		.filter((l): l is number => l !== null);

	let highBreakoutPct = 0;
	if (dayHighs.length > 0) {
		const maxDayHigh = Math.max(...dayHighs);
		if (maxDayHigh > 0) {
			highBreakoutPct = Math.max(
				0,
				((currentPrice - maxDayHigh) / maxDayHigh) * 100,
			);
		}
	}

	let lowBreakoutPct = 0;
	if (dayLows.length > 0) {
		const minDayLow = Math.min(...dayLows);
		if (minDayLow > 0) {
			lowBreakoutPct = Math.max(
				0,
				((minDayLow - currentPrice) / minDayLow) * 100,
			);
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
		maxPoints: fullMaxPoints,
		triggered,
		detail: triggered
			? `${direction} breakout +${breakoutPct.toFixed(2)}%${isEarlyDay ? " (early-day cap)" : ""}`
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
		detail: hasEarningsNearby
			? "earnings within 2 days"
			: "no upcoming earnings",
	};
}

/* =============
Composite Scoring
============= */

/**
 * Compute the composite anomaly score for a symbol.
 *
 * 4 signals, max 100 points:
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
}): AnomalyResult {
	const {
		currentQuote,
		snapshots,
		hasEarningsNearby,
		benchmarkMovePct,
		avgVolume20d,
		atr14,
		isEarlyDay,
	} = options;

	// Need enough data to make meaningful comparisons
	if (snapshots.length < MIN_SNAPSHOTS) {
		return {
			score: 0,
			signals: [],
			summary: `Insufficient data (${snapshots.length}/${MIN_SNAPSHOTS} snapshots)`,
		};
	}

	const { signal: priceSignal, excessMovePct: excessForGate } =
		computeExcessPriceMoveWithMetrics(
			currentQuote,
			snapshots,
			benchmarkMovePct,
			avgVolume20d,
			atr14,
		);

	const volumeSignal = computeVolumeSignal(
		currentQuote,
		snapshots,
		excessMovePct,
		avgVolume20d,
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
