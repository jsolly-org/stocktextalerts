import type { MarketSession } from "../types";

export const marketSessionCacheStore = {
	value: null as {
		humanSession: MarketSession;
		equitySession: MarketSession;
		atMs: number;
	} | null,
};
