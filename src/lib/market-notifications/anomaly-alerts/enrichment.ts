import { formatUsdPrice } from "../../messaging/parts/asset-price-list";
import type { EnrichedAlert } from "../../price-alerts/types";
import type { ExtendedAssetQuote } from "../../types";
import { generatePriceAlertSummary } from "./grok-summary";

export function calculatePercentMove(quote: ExtendedAssetQuote): number | null {
	if (quote.prevClose !== null && quote.prevClose > 0) {
		return ((quote.price - quote.prevClose) / quote.prevClose) * 100;
	}
	if (Number.isFinite(quote.changePercent)) {
		return quote.changePercent;
	}
	return null;
}

export function calculateDollarMove(
	quote: ExtendedAssetQuote,
	percentMove: number | null,
): number | null {
	if (quote.prevClose !== null && quote.prevClose > 0) {
		return quote.price - quote.prevClose;
	}
	if (percentMove === null) {
		return null;
	}
	const denominator = 1 + percentMove / 100;
	if (Math.abs(denominator) < 0.000001) {
		return null;
	}
	const inferredPrevClose = quote.price / denominator;
	return quote.price - inferredPrevClose;
}

export function buildSignalContexts(options: {
	percentMove: number;
	dollarMove: number;
	anomalyScore: number;
	maxPossibleScore: number;
	anomalySummary: string;
	hasEarningsNearby: boolean;
	benchmarkMovePercentAbs: number | null;
	benchmarkMoveSigned: number | null;
	benchmarkLabel: string;
}): { grokContext: string; userSignalContext: string } {
	const {
		percentMove,
		dollarMove,
		anomalyScore,
		maxPossibleScore,
		anomalySummary,
		hasEarningsNearby,
		benchmarkMovePercentAbs,
		benchmarkMoveSigned,
		benchmarkLabel,
	} = options;
	const direction = percentMove >= 0 ? "Up" : "Down";
	const absPct = Math.abs(percentMove).toFixed(2);
	const absDollar = Math.abs(dollarMove).toFixed(2);

	// Grok context: technical detail for AI enrichment
	const grokBase = `${direction.toLowerCase()} ${absPct}% ($${absDollar}) from previous close`;
	const scoreLabel = `anomaly score ${anomalyScore}/${maxPossibleScore} (${anomalySummary})`;
	const grokMarket =
		benchmarkMovePercentAbs !== null
			? `${benchmarkLabel} moved ${benchmarkMovePercentAbs.toFixed(2)}%`
			: null;
	const grokEarnings = hasEarningsNearby ? "earnings are within ~2 days" : null;

	const grokContext = [grokBase, scoreLabel, grokMarket, grokEarnings]
		.filter((value): value is string => value !== null)
		.join(", ");

	// User context: additional info beyond the price move (which priceContext already covers)
	const benchmarkDirection =
		benchmarkMoveSigned !== null ? (benchmarkMoveSigned >= 0 ? "up" : "down") : null;
	const userMarket =
		benchmarkMovePercentAbs !== null && benchmarkDirection !== null
			? `The ${benchmarkLabel} moved ${benchmarkDirection} ${benchmarkMovePercentAbs.toFixed(2)}% today.`
			: null;
	const userEarnings = hasEarningsNearby
		? "Earnings are expected within the next couple of days."
		: null;

	const userSignalContext = [userMarket, userEarnings]
		.filter((value): value is string => value !== null)
		.join(" ");

	return { grokContext, userSignalContext };
}

/** Build a human-readable price context string. */
function buildPriceContext(symbol: string, quote: ExtendedAssetQuote): string {
	const direction = quote.changePercent >= 0 ? "up" : "down";
	// Single-asset alert HEADLINE rounds change% to 1 decimal ("up 5.2% today") for
	// readability — deliberately coarser than the 2-decimal precision on multi-asset price
	// lines (asset-formatting.ts). The flat-alert subject builder mirrors this convention.
	const absChange = Math.abs(quote.changePercent).toFixed(1);
	return `${symbol} is ${direction} ${absChange}% today (${formatUsdPrice(quote.price)})`;
}

/** Enrich a triggered alert with Grok context (summary + links) and intraday closes for sparklines. */
export async function enrichAlert(options: {
	symbol: string;
	quote: ExtendedAssetQuote;
	grokContext: string;
	userSignalContext: string;
	intradayCloses: number[] | null;
	intradayTimestamps: (number | null)[] | null;
	intradayEndTimestamp: number | null;
	intradayCandles: EnrichedAlert["intradayCandles"];
	iconUrl?: string | null;
	iconBase64?: string | null;
	benchmarkDirection?: "up" | "down" | null;
}): Promise<EnrichedAlert> {
	const {
		symbol,
		quote,
		grokContext,
		userSignalContext,
		intradayCloses,
		intradayTimestamps,
		intradayEndTimestamp,
		intradayCandles,
		iconUrl,
		iconBase64,
		benchmarkDirection,
	} = options;

	const priceContext = buildPriceContext(symbol, quote);

	const grokResult = await generatePriceAlertSummary({
		symbol,
		priceContext,
		signalContext: grokContext,
	});

	return {
		symbol,
		priceContext,
		signalContext: userSignalContext,
		grokContext,
		grokResult,
		intradayCloses,
		intradayTimestamps,
		intradayEndTimestamp,
		intradayCandles,
		prevClose: quote.prevClose,
		isPositiveMove: quote.changePercent >= 0,
		iconUrl,
		iconBase64,
		benchmarkDirection,
	};
}
