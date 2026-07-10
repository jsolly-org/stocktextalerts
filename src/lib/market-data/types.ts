import type { AppSupabaseClient } from "../db/supabase";
import type { ExtendedQuoteMap } from "../types";

export interface TopMover {
	ticker: string;
	price: number;
	changePercent: number;
}

/**
 * Price map plus a side-channel set of symbols whose ticker entry was
 * returned by Massive but had no live trade in the current session.
 */
export interface AssetPricesWithSessionState {
	prices: ExtendedQuoteMap;
	noSessionTrade: Set<string>;
}

export type SparklineCacheOptions = {
	supabase: AppSupabaseClient;
	timezone?: string;
	use24HourTime?: boolean;
};
