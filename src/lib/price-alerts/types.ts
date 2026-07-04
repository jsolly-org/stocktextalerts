import type { IntradayCandle } from "../types";

/** A single link returned by Grok for a price alert. */
interface PriceAlertLink {
	url: string;
	title: string;
	source: string;
	sourceType: "x" | "web";
}

/** Structured result from a Grok price alert call: summary + up to 3 links. */
export interface PriceAlertGrokResult {
	/** Summary with inline markdown links (e.g. `[[Reuters]](url)`). */
	summary: string;
	/** Extracted links for plaintext/SMS fallback. */
	links: PriceAlertLink[];
}

/** Structured price-move facts each channel renders into its own headline sentence
 *  (e.g. "LDOS is down 11.1% today ($173.00)"). Shared as data, not a pre-rendered string. */
export interface PriceMoveFacts {
	symbol: string;
	changePercent: number;
	price: number;
	/** Time-window phrase, e.g. "today" or "since last alert (27 min ago)". */
	period: string;
}

/** Structured signal facts each channel renders into its own signal sentence
 *  (benchmark move + earnings proximity). `benchmarkMovePercent` is signed (direction
 *  from its sign, magnitude from its absolute value); null when no benchmark move is known. */
export interface SignalFacts {
	benchmarkLabel: string;
	benchmarkMovePercent: number | null;
	hasEarningsNearby: boolean;
}

/** Alert enriched with Grok-sourced context and intraday closing prices for sparkline rendering. */
export interface EnrichedAlert {
	symbol: string;
	/** Structured price-move facts; each channel renders its own headline sentence. */
	priceMove: PriceMoveFacts;
	/** Structured signal facts, or null when there's no user-facing signal to show. */
	signal: SignalFacts | null;
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
}
