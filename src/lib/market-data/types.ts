import type { SupabaseAdminClient } from "../schedule/helpers";

/**
 * Sentinel when Massive returned the ticker entry but no live trade exists for
 * the current session. Distinct from `null` (ticker missing from response).
 */
export const NO_SESSION_TRADE = "no_session_trade" as const;
export type NoSessionTrade = typeof NO_SESSION_TRADE;

/** A single intraday OHLC bar (`t` is ms since epoch). */
export interface IntradayCandle {
	o: number;
	h: number;
	l: number;
	c: number;
	t: number;
}

/** Result of extracting closes and timestamps from intraday bars. */
export interface IntradayBarsResult {
	closes: number[];
	timestamps: (number | null)[] | null;
	startTimestamp: number | null;
	endTimestamp: number | null;
	candles: IntradayCandle[] | null;
}

/** Single daily OHLCV bar extracted from Massive aggregates. */
export interface DailyOHLCVBar {
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	tradingDate?: string;
}

export interface TopMover {
	ticker: string;
	price: number;
	changePercent: number;
}

interface AssetPrice {
	price: number;
	changePercent: number;
	timestamp?: number | null;
	prevClose?: number | null;
}

/** Quote fields used by movement alerts and snapshot persistence. */
export interface ExtendedAssetQuote extends AssetPrice {
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

/** Map of simple price quotes keyed by symbol. `null` = ticker missing (fetch fail / no live trade). */
export type AssetPriceMap = Map<string, AssetPrice | null>;
/** Map of extended quotes keyed by symbol. */
export type ExtendedQuoteMap = Map<string, ExtendedAssetQuote | null>;

/**
 * Price map plus a side-channel set of symbols whose ticker entry was
 * returned by Massive but had no live trade in the current session.
 */
export interface AssetPricesWithSessionState {
	prices: AssetPriceMap;
	noSessionTrade: Set<string>;
}

export type MarketSession = "pre" | "regular" | "after" | "closed";

export type SparklineCacheOptions = {
	supabase: SupabaseAdminClient;
	timezone?: string;
	use24HourTime?: boolean;
};
