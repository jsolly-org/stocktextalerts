import { marketDataFetch } from "../vendors/massive";
import type { TopMover } from "./types";

export type { TopMover };

interface SnapshotTicker {
	ticker: string;
	todaysChangePerc?: number;
	day?: {
		c: number;
	};
}

/** Fetch market-wide top gainers or losers for the current session. */
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
