import type { SupabaseAdminClient } from "../schedule/helpers";

// Re-exported so messaging-layer consumers don't reach into `vendors/massive/snapshot`
// directly — market-data is the public abstraction over the snapshot API.
export { NO_SESSION_TRADE, type NoSessionTrade } from "../vendors/massive/snapshot";

interface AssetPrice {
	price: number;
	changePercent: number;
	timestamp?: number | null;
	/** Yesterday's close (Massive `prevDay.c`). */
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
 *
 * Only the scheduled-notification renderer consumes `noSessionTrade` (to
 * show "no pre-market trades" instead of the generic "price unavailable").
 * Movement alerts, snapshot persistence, the daily digest, etc. don't
 * distinguish — a `null` entry in `prices` is treated the same regardless
 * of cause, so they use `fetchAssetPrices` / `fetchExtendedQuotes` directly.
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
