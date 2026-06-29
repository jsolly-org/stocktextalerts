import { marketSessionCacheStore } from "../../src/lib/schedule/market-session-cache-store";

export function resetMarketSessionCache(): void {
	marketSessionCacheStore.value = null;
}
