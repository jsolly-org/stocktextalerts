import { earningsCalendarCache } from "../../src/lib/asset-events/earnings-cache-store";

export function resetEarningsCache(): void {
	earningsCalendarCache.clear();
}
