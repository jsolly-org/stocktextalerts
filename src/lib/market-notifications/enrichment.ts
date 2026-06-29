import { formatUsdPrice } from "../messaging/parts/asset-price-list";
import type { EnrichedAlert } from "../price-alerts/types";
import type { ExtendedAssetQuote } from "../types";
import { generatePriceAlertSummary } from "./grok-summary";

export type { EnrichedAlert } from "../price-alerts/types";

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
