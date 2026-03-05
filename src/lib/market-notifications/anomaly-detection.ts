import type { CompanyNewsItem } from "../providers/company-news";
import type { ExtendedAssetQuote } from "../providers/price-fetcher";
import type { AssetSnapshot } from "./snapshot-store";

/* =============
Configuration
============= */

const MIN_SNAPSHOTS = 5;

/** Volume multiplier when volume data is unavailable (penalizes missing data). */
const UNKNOWN_VOLUME_MULTIPLIER = 0.8;

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
function estimateAverageVolume(snapshots: AssetSnapshot[]): number | null {
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

/** Compute the price-move signal (volatility-normalized and volume-scaled). */
function computePriceMove(
	currentQuote: ExtendedAssetQuote,
	snapshots: AssetSnapshot[],
): SignalBreakdown {
	const maxPoints = 45;
	const oldest = snapshots[0];
	const latest = snapshots[snapshots.length - 1];

	// Sustained move: oldest snapshot → current
	const sustainedMovePct =
		oldest.price > 0
			? Math.abs(((currentQuote.price - oldest.price) / oldest.price) * 100)
			: 0;

	// Sudden move: latest snapshot → current
	const suddenMovePct =
		latest.price > 0
			? Math.abs(((currentQuote.price - latest.price) / latest.price) * 100)
			: 0;

	const rawMovePct = Math.max(sustainedMovePct, suddenMovePct);

	// Intraday range for volatility normalization
	const dayHigh = currentQuote.dayHigh ?? currentQuote.price;
	const dayLow = currentQuote.dayLow ?? currentQuote.price;
	const intradayRangePct = dayLow > 0 ? ((dayHigh - dayLow) / dayLow) * 100 : 0;
	const normalizedMove = rawMovePct / Math.max(intradayRangePct, 0.5);

	// Scale: normalizedMove / 2.0 (a move of 2x the day's range = max points)
	const priceRatio = Math.min(normalizedMove / 2.0, 1.0);
	const rawPts = Math.round(priceRatio * maxPoints);

	// Volume multiplier: 0.5x–1.5x based on currentVolume / medianSnapshotVolume
	const medianVolume = estimateAverageVolume(snapshots);
	let volumeMultiplier = UNKNOWN_VOLUME_MULTIPLIER;
	if (
		currentQuote.volume !== null &&
		medianVolume !== null &&
		medianVolume > 0
	) {
		const volRatio = currentQuote.volume / medianVolume;
		volumeMultiplier = Math.max(0.5, Math.min(volRatio, 1.5));
	}

	const points = Math.min(Math.round(rawPts * volumeMultiplier), maxPoints);
	const moveType = sustainedMovePct >= suddenMovePct ? "sustained" : "sudden";
	const referencePrice = moveType === "sustained" ? oldest.price : latest.price;
	const direction = currentQuote.price >= referencePrice ? "up" : "down";

	return {
		name: "price_move",
		points,
		maxPoints,
		triggered: points > 0,
		detail: `${direction} ${rawMovePct.toFixed(2)}% (${moveType}, vol ${volumeMultiplier.toFixed(1)}x)`,
	};
}

/** Compute the range-breakout signal (high/low breakout vs recent intraday range). */
function computeRangeBreakout(
	currentPrice: number,
	snapshots: AssetSnapshot[],
): SignalBreakdown {
	const maxPoints = 15;

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

	// Linear scale: 0.5% = 1 pt, 2.0% = 15 pts
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
			? `${direction} breakout +${breakoutPct.toFixed(2)}%`
			: "within day range",
	};
}

/** Compute the breaking-news signal (headlines count + recency). */
function computeNewsSignal(news: CompanyNewsItem[] | null): SignalBreakdown {
	const maxPoints = 25;

	if (!news || news.length === 0) {
		return {
			name: "breaking_news",
			points: 0,
			maxPoints,
			triggered: false,
			detail: "no breaking news",
		};
	}

	let points = 10; // base for any news

	if (news.length >= 2) points += 5; // corroboration
	if (news.length >= 3) points += 5; // significant coverage

	// Recency: any headline from last 2 hours
	const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
	const hasRecentHeadline = news.some((n) => n.datetime >= twoHoursAgo);
	if (hasRecentHeadline) points += 5;

	points = Math.min(points, maxPoints);

	return {
		name: "breaking_news",
		points,
		maxPoints,
		triggered: true,
		detail: `${news.length} headline${news.length === 1 ? "" : "s"}${hasRecentHeadline ? " (recent)" : ""}`,
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

/** Compute the composite anomaly score for a symbol.
 *
 *  When `benchmarkMovePct` is provided, the price signal is dampened
 *  proportionally to how much of the stock's move is explained by
 *  the sector/market benchmark moving in the same direction.
 */
export function computeAnomalyScore(options: {
	currentQuote: ExtendedAssetQuote;
	snapshots: AssetSnapshot[];
	news: CompanyNewsItem[] | null;
	hasEarningsNearby: boolean;
	/** Benchmark (sector ETF or SPY) percent move, signed. */
	benchmarkMovePct?: number | null;
}): AnomalyResult {
	const { currentQuote, snapshots, news, hasEarningsNearby, benchmarkMovePct } =
		options;

	// Need enough data to make meaningful comparisons
	if (snapshots.length < MIN_SNAPSHOTS) {
		return {
			score: 0,
			signals: [],
			summary: `Insufficient data (${snapshots.length}/${MIN_SNAPSHOTS} snapshots)`,
		};
	}

	const priceSignal = computePriceMove(currentQuote, snapshots);

	// Dampen price score when the move tracks the benchmark direction.
	// Use intraday signal direction/magnitude (snapshot-relative), not day-level
	// changePercent — a stock can be up on the day but crashing intraday.
	if (
		benchmarkMovePct != null &&
		priceSignal.points > 0 &&
		snapshots.length > 0
	) {
		const oldest = snapshots[0];
		const latest = snapshots[snapshots.length - 1];
		const sustainedSigned =
			oldest.price > 0
				? ((currentQuote.price - oldest.price) / oldest.price) * 100
				: 0;
		const suddenSigned =
			latest.price > 0
				? ((currentQuote.price - latest.price) / latest.price) * 100
				: 0;
		const signalMovePct =
			Math.abs(sustainedSigned) >= Math.abs(suddenSigned)
				? sustainedSigned
				: suddenSigned;
		const stockDir = Math.sign(signalMovePct);
		const benchDir = Math.sign(benchmarkMovePct);
		if (stockDir === benchDir && Math.abs(signalMovePct) > 0) {
			const explainedRatio = Math.min(
				Math.abs(benchmarkMovePct) / Math.abs(signalMovePct),
				1.0,
			);
			// Keep at least 30% of the price score even when fully explained
			const dampening = 1.0 - explainedRatio * 0.7;
			priceSignal.points = Math.round(priceSignal.points * dampening);
			priceSignal.detail += `, benchmark ${benchmarkMovePct >= 0 ? "+" : ""}${benchmarkMovePct.toFixed(2)}%`;
		}
	}

	const signals: SignalBreakdown[] = [
		priceSignal,
		computeRangeBreakout(currentQuote.price, snapshots),
		computeNewsSignal(news),
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

/** Compute the price-only score (before any news fetch). */
export function computePriceOnlyScore(options: {
	currentQuote: ExtendedAssetQuote;
	snapshots: AssetSnapshot[];
	hasEarningsNearby: boolean;
	benchmarkMovePct?: number | null;
}): number {
	return computeAnomalyScore({
		...options,
		news: null,
	}).score;
}
