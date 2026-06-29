import type { MarketSession } from "../types";

export const marketSessionCacheStore = {
	value: null as { session: MarketSession; atMs: number } | null,
};
