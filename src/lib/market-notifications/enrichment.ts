import type { ExtendedAssetQuote, IntradayCandle } from "../market-data-types";
import { formatUsdPrice } from "../messaging/parts/asset-price-list";
import { generatePriceAlertSummary, type PriceAlertGrokResult } from "./grok-summary";

/** Alert enriched with Grok-sourced context and intraday closing prices for sparkline rendering. */
export interface EnrichedAlert {
	symbol: string;
	priceContext: string;
	/** User-facing signal summary (no anomaly internals). */
	signalContext: string;
	/** Detailed context for Grok enrichment (includes anomaly score). */
	grokContext: string;
	/** Grok-sourced summary + links, or null if Grok failed/unavailable. */
	grokResult: PriceAlertGrokResult | null;
	intradayCloses: number[] | null;
	/** Per-bar timestamps (ms) for time-axis sparkline; null for bars lacking t; null when no bars have timestamps. */
	intradayTimestamps: (number | null)[] | null;
	/** Last bar timestamp (ms) for sparkline axis; null when bars lack timestamps. */
	intradayEndTimestamp: number | null;
	/** Per-bar intraday OHLC candles for the Telegram candlestick chart; null when bars lacked full OHLC+t. */
	intradayCandles: IntradayCandle[] | null;
	/** Yesterday's close, prepended to the chart so its first-to-last delta
	 *  equals the prev-close-anchored headline %. Null when Massive didn't
	 *  return a prevDay bar (delisted / fresh listing). */
	prevClose: number | null;
	/** True when price moved up (changePercent >= 0). Used for subject-line direction. */
	isPositiveMove: boolean;
	/** Logo URL from the assets table (fetched at delivery time). */
	iconUrl?: string | null;
	/** Pre-cached base64 logo data URI from the assets table. */
	iconBase64?: string | null;
	/** Direction of the benchmark (sector/market) move, for color-coding in emails. */
	benchmarkDirection?: "up" | "down" | null;
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
	intradayCandles: IntradayCandle[] | null;
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
