import type { MarketSession } from "../market-data-types";

export const marketSessionCacheStore = {
	value: null as { session: MarketSession; atMs: number } | null,
};
