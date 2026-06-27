import type { MarketSession } from "../../market-data/types";
import { marketDataFetch } from "./client";

/**
 * Snapshot ticker shape from Massive `/v2/snapshot/locale/us/markets/stocks/tickers`.
 */
interface SnapshotTicker {
	ticker: string;
	todaysChangePerc?: number;
	updated?: number; // nanoseconds
	day?: {
		o: number;
		h: number;
		l: number;
		c: number;
		v: number;
	};
	min?: {
		c: number;
	};
	prevDay?: {
		c: number;
	};
}

interface SnapshotQuote {
	price: number;
	changePercent: number;
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

/**
 * Sentinel emitted by `parseSnapshotTicker` when Massive returned the ticker
 * entry but no live trade exists for the current session (both `day.c` and
 * `min.c` are zero/missing). Distinct from `null`, which means the ticker
 * wasn't in the response at all. Renderers use this to differentiate
 * "no pre-market trades" (illiquid ticker, session is normal) from
 * "price unavailable" (fetch failure or delisting).
 */
export const NO_SESSION_TRADE = "no_session_trade" as const;
export type NoSessionTrade = typeof NO_SESSION_TRADE;

function parseSnapshotTicker(
	t: SnapshotTicker,
	session: MarketSession,
): SnapshotQuote | NoSessionTrade | null {
	const isPositive = (v: unknown): v is number =>
		typeof v === "number" && Number.isFinite(v) && v !== 0;

	// Pick the freshest live-trade source given the session. During regular
	// hours `day.c` is the rolling close (authoritative). During pre/after
	// `day.c` is unrepresentative (zero pre-market; locked at the 4 PM close
	// after the bell), so `min.c` (latest extended-hours minute bar) wins.
	// During `closed`, day.c carries the last regular session's close — what
	// the user expects to see on a weekend.
	const preferMinFirst = session === "pre" || session === "after";
	let price: number | null = null;
	if (preferMinFirst) {
		if (isPositive(t.min?.c)) price = t.min.c;
		else if (isPositive(t.day?.c)) price = t.day.c;
	} else {
		if (isPositive(t.day?.c)) price = t.day.c;
		else if (isPositive(t.min?.c)) price = t.min.c;
	}
	// Massive returned this ticker entry, just no live trade in this session.
	if (price === null) return NO_SESSION_TRADE;

	// Derive change-% from the price we surface (day.c / min.c) against
	// prevDay.c — the same two numbers that anchor the intraday sparkline.
	// Massive's todaysChangePerc comes from its own trade feed, which updates
	// on a different cadence than the aggregates; near-flat days the two can
	// disagree in sign (LDOS 2026-06-11: todaysChangePerc -0.06% while
	// day.c vs prevDay.c read +0.45%, so a red headline % sat beside a green
	// prev-close-anchored chart). todaysChangePerc remains only as a fallback
	// for tickers without a usable prevDay bar (fresh listings).
	const prevClose = t.prevDay?.c;
	let changePercent: number;
	if (typeof prevClose === "number" && Number.isFinite(prevClose) && prevClose > 0) {
		changePercent = ((price - prevClose) / prevClose) * 100;
	} else if (typeof t.todaysChangePerc === "number" && Number.isFinite(t.todaysChangePerc)) {
		changePercent = t.todaysChangePerc;
	} else {
		return null;
	}

	const numPrice = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null;
	const numVolume = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

	return {
		price,
		changePercent,
		dayHigh: numPrice(t.day?.h),
		dayLow: numPrice(t.day?.l),
		dayOpen: numPrice(t.day?.o),
		prevClose: numPrice(t.prevDay?.c),
		// Massive `updated` is in nanoseconds — convert to seconds for consistency
		timestamp:
			typeof t.updated === "number" && Number.isFinite(t.updated)
				? Math.floor(t.updated / 1_000_000_000)
				: null,
		volume: numVolume(t.day?.v),
	};
}

const SNAPSHOT_QUOTES_MAX_TICKERS_PER_REQUEST = 250;
const SNAPSHOT_QUOTES_LARGE_BATCH_TIMEOUT_MS = 35_000;
const SNAPSHOT_QUOTES_CHUNK_CONCURRENCY = 2;

function chunkSymbols(symbols: string[], chunkSize: number): string[][] {
	const chunks: string[][] = [];
	for (let index = 0; index < symbols.length; index += chunkSize) {
		chunks.push(symbols.slice(index, index + chunkSize));
	}
	return chunks;
}

function mergeSnapshotChunkIntoResult(
	target: Map<string, SnapshotQuote | NoSessionTrade | null>,
	chunk: Map<string, SnapshotQuote | NoSessionTrade | null>,
): void {
	for (const [symbol, entry] of chunk) {
		if (entry !== null) {
			target.set(symbol, entry);
		}
	}
}

async function fetchSnapshotQuotesChunk(options: {
	symbols: string[];
	session: MarketSession;
	chunkIndex: number;
	chunkCount: number;
	totalTickerCount: number;
}): Promise<Map<string, SnapshotQuote | NoSessionTrade | null>> {
	const { symbols, session, chunkIndex, chunkCount, totalTickerCount } = options;
	const chunkResult = new Map<string, SnapshotQuote | NoSessionTrade | null>();
	for (const symbol of symbols) {
		chunkResult.set(symbol, null);
	}

	const policy =
		symbols.length >= SNAPSHOT_QUOTES_MAX_TICKERS_PER_REQUEST
			? { requestTimeoutMs: SNAPSHOT_QUOTES_LARGE_BATCH_TIMEOUT_MS }
			: undefined;

	const data = await marketDataFetch(
		"/v2/snapshot/locale/us/markets/stocks/tickers",
		{ tickers: symbols.join(",") },
		"snapshot-quotes",
		{ tickerCount: totalTickerCount, chunkIndex, chunkCount },
		policy,
	);

	if (typeof data !== "object" || data === null) {
		return chunkResult;
	}

	const tickers = (data as Record<string, unknown>).tickers;
	if (!Array.isArray(tickers)) {
		return chunkResult;
	}

	for (const raw of tickers) {
		if (typeof raw !== "object" || raw === null) continue;
		const t = raw as SnapshotTicker;
		if (typeof t.ticker !== "string") continue;

		const entry = parseSnapshotTicker(t, session);
		if (entry !== null) {
			chunkResult.set(t.ticker, entry);
		}
	}

	return chunkResult;
}

/**
 * Batch-fetch snapshot quotes for a list of symbols via a single Massive API call.
 *
 * Uses `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=A,B,C`.
 *
 * Map value semantics:
 * - `SnapshotQuote` — Massive returned the ticker and a live trade exists.
 * - `"no_session_trade"` — Massive returned the ticker entry but `day.c` and
 *   `min.c` are both zero/missing (typical for illiquid names during
 *   pre/after-hours). Distinct so renderers can show "no pre-market trades"
 *   instead of the generic "price unavailable".
 * - `null` — Massive did not include the ticker in the response (fetch
 *   failure, delisting, OTC pre-listing, etc.).
 */
export async function fetchSnapshotQuotes(
	symbols: string[],
	session: MarketSession,
): Promise<Map<string, SnapshotQuote | NoSessionTrade | null>> {
	const result = new Map<string, SnapshotQuote | NoSessionTrade | null>();
	if (symbols.length === 0) return result;

	// Pre-fill with null so callers always see every requested symbol
	for (const s of symbols) result.set(s, null);

	const chunks = chunkSymbols(symbols, SNAPSHOT_QUOTES_MAX_TICKERS_PER_REQUEST);
	const chunkCount = chunks.length;
	const queue = chunks.map((chunk, index) => ({ chunk, chunkIndex: index + 1 }));
	const pending: Promise<void>[] = [];

	async function worker(): Promise<void> {
		while (true) {
			const next = queue.shift();
			if (next === undefined) break;
			const chunkResult = await fetchSnapshotQuotesChunk({
				symbols: next.chunk,
				session,
				chunkIndex: next.chunkIndex,
				chunkCount,
				totalTickerCount: symbols.length,
			});
			mergeSnapshotChunkIntoResult(result, chunkResult);
		}
	}

	for (let i = 0; i < Math.min(SNAPSHOT_QUOTES_CHUNK_CONCURRENCY, queue.length); i++) {
		pending.push(worker());
	}
	await Promise.all(pending);

	return result;
}

/**
 * Full previous-day bar returned by `fetchPrevDayBar`. Shape is compatible
 * with `ExtendedAssetQuote` so callers can drop it into snapshot maps.
 * `changePercent` is always 0 for this path — it represents stale data
 * from the last trading day, not today's change.
 */
interface PrevDayBar {
	price: number;
	changePercent: number;
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

/**
 * Fetch the previous-day OHLCV bar for a single symbol.
 *
 * Uses `/v2/aggs/ticker/{symbol}/prev?adjusted=true` — same endpoint as
 * `fetchPrevClose`, but returns the full bar so snapshot-miss fallbacks can
 * populate dayHigh/Low/Open/volume instead of null-filling them.
 *
 * Returns `null` when the symbol has no prev-day data or the response shape
 * is unexpected.
 */
export async function fetchPrevDayBar(symbol: string): Promise<PrevDayBar | null> {
	const data = await marketDataFetch(
		`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`,
		{ adjusted: "true" },
		"prev-day-bar",
	);
	if (typeof data !== "object" || data === null) return null;

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results) || results.length === 0) return null;

	const first = results[0];
	if (typeof first !== "object" || first === null) return null;
	const row = first as Record<string, unknown>;

	const close = row.c;
	if (typeof close !== "number" || !Number.isFinite(close) || close === 0) {
		return null;
	}

	const numPrice = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null;
	const numVolume = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
	// Massive `/v2/aggs` daily-bar `t` is milliseconds; AssetPrice.timestamp is
	// Unix seconds elsewhere (snapshot path converts ns→s; digest formatter
	// multiplies s→ms). Normalize here to keep the invariant.
	const numTimestampSeconds = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v / 1000) : null;

	return {
		price: close,
		changePercent: 0,
		dayHigh: numPrice(row.h),
		dayLow: numPrice(row.l),
		dayOpen: numPrice(row.o),
		// `prevClose` would require a second /aggs call (the close of the day
		// before this bar's day). Leave it null rather than duplicating `price`
		// — the live snapshot path uses prevClose to show "yesterday's close
		// vs today's price"; reusing `close` here would display the same
		// number twice to end users.
		prevClose: null,
		timestamp: numTimestampSeconds(row.t),
		volume: numVolume(row.v),
	};
}
