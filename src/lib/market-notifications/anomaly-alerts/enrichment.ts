import { renderPriceAlertHeadline } from "../../messaging/parts/price-alert-sentences";
import type { EnrichedAlert, SignalFacts } from "../../price-alerts/types";
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
}): { grokContext: string; signal: SignalFacts | null } {
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

	// User-facing signal facts (structured — each channel renders its own sentence). Beyond
	// the price move (which the headline already covers): benchmark direction/size + earnings
	// proximity. Signed `benchmarkMovePercent` carries both direction and magnitude; it is null
	// together with `benchmarkMovePercentAbs` (both derive from the same benchmark quote), so the
	// signal is null exactly when there is no benchmark move AND no nearby earnings to report.
	const signal: SignalFacts | null =
		benchmarkMoveSigned === null && !hasEarningsNearby
			? null
			: { benchmarkLabel, benchmarkMovePercent: benchmarkMoveSigned, hasEarningsNearby };

	return { grokContext, signal };
}

/** Enrich a triggered alert with Grok context (summary + links) and intraday closes for sparklines. */
export async function enrichAlert(options: {
	symbol: string;
	quote: ExtendedAssetQuote;
	grokContext: string;
	signal: SignalFacts | null;
	intradayCloses: number[] | null;
	intradayTimestamps: (number | null)[] | null;
	intradayEndTimestamp: number | null;
	intradayCandles: EnrichedAlert["intradayCandles"];
	iconUrl?: string | null;
	iconBase64?: string | null;
}): Promise<EnrichedAlert> {
	const {
		symbol,
		quote,
		grokContext,
		signal,
		intradayCloses,
		intradayTimestamps,
		intradayEndTimestamp,
		intradayCandles,
		iconUrl,
		iconBase64,
	} = options;

	const priceMove: EnrichedAlert["priceMove"] = {
		symbol,
		changePercent: quote.changePercent,
		price: quote.price,
		period: "today",
	};

	const grokResult = await generatePriceAlertSummary({
		// The Grok prompt reuses today's headline sentence — same facts, rendered once here.
		priceContext: renderPriceAlertHeadline(priceMove),
		symbol,
		signalContext: grokContext,
	});

	return {
		symbol,
		priceMove,
		signal,
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
	};
}
