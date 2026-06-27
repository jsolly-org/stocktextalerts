import { marketDataFetch } from "./client";

/**
 * Snapshot ticker shape from Massive `/v2/snapshot/locale/us/markets/stocks/tickers`.
 */
interface SnapshotTicker {
	ticker: string;
	todaysChangePerc?: number;
	day?: {
		c: number;
	};
}

export interface TopMover {
	ticker: string;
	price: number;
	changePercent: number;
}

/**
 * Fetch market-wide top gainers or losers for the current session.
 *
 * Uses `/v2/snapshot/locale/us/markets/stocks/{gainers|losers}`, which
 * returns tickers already sorted by `todaysChangePerc`. Sub-$5 names are
 * filtered out to cut penny-stock / warrant noise, and tickers showing
 * `todaysChangePerc === 0` are skipped — on the movers endpoint a 0% entry
 * means the ticker genuinely hasn't moved today, so it doesn't belong on a
 * gainers/losers list.
 *
 * Returns up to `limit` results. Fewer may be returned if the upstream
 * response is small or most tickers fail the price filter.
 */
export async function fetchTopMovers(
	direction: "gainers" | "losers",
	options?: { limit?: number; minPrice?: number; optional?: boolean },
): Promise<TopMover[]> {
	const limit = options?.limit ?? 5;
	const minPrice = options?.minPrice ?? 5;
	const policy = options?.optional
		? { optional: true, maxRetries: 1, requestTimeoutMs: 10_000 }
		: undefined;

	const data = await marketDataFetch(
		`/v2/snapshot/locale/us/markets/stocks/${direction}`,
		{},
		`top-${direction}`,
		undefined,
		policy,
	);
	if (typeof data !== "object" || data === null) return [];

	const tickers = (data as Record<string, unknown>).tickers;
	if (!Array.isArray(tickers)) return [];

	const movers: TopMover[] = [];
	for (const raw of tickers) {
		if (typeof raw !== "object" || raw === null) continue;
		const t = raw as SnapshotTicker;
		if (typeof t.ticker !== "string") continue;

		// Use the endpoint's own todaysChangePerc (what it sorts by) directly,
		// not parseSnapshotTicker's prev-close derivation: a 0% entry here means
		// the ticker genuinely hasn't moved today, not that the market is closed.
		const changePercent = t.todaysChangePerc;
		if (
			typeof changePercent !== "number" ||
			!Number.isFinite(changePercent) ||
			changePercent === 0
		) {
			continue;
		}

		const price = t.day?.c;
		if (typeof price !== "number" || !Number.isFinite(price) || price === 0) {
			continue;
		}
		if (price < minPrice) continue;

		movers.push({ ticker: t.ticker, price, changePercent });
		if (movers.length >= limit) break;
	}

	return movers;
}
