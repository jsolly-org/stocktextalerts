import type { MarketSession, NoSessionTrade } from "../market-data-types";
import { NO_SESSION_TRADE } from "../market-data-types";
import { marketDataFetch } from "../vendors/massive";

interface SnapshotTicker {
	ticker: string;
	todaysChangePerc?: number;
	updated?: number;
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

function parseSnapshotTicker(
	t: SnapshotTicker,
	session: MarketSession,
): SnapshotQuote | NoSessionTrade | null {
	const isPositive = (v: unknown): v is number =>
		typeof v === "number" && Number.isFinite(v) && v !== 0;

	const preferMinFirst = session === "pre" || session === "after";
	let price: number | null = null;
	if (preferMinFirst) {
		if (isPositive(t.min?.c)) price = t.min.c;
		else if (isPositive(t.day?.c)) price = t.day.c;
	} else {
		if (isPositive(t.day?.c)) price = t.day.c;
		else if (isPositive(t.min?.c)) price = t.min.c;
	}
	if (price === null) return NO_SESSION_TRADE;

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

export async function fetchSnapshotQuotes(
	symbols: string[],
	session: MarketSession,
): Promise<Map<string, SnapshotQuote | NoSessionTrade | null>> {
	const result = new Map<string, SnapshotQuote | NoSessionTrade | null>();
	if (symbols.length === 0) return result;

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
	const numTimestampSeconds = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v / 1000) : null;

	return {
		price: close,
		changePercent: 0,
		dayHigh: numPrice(row.h),
		dayLow: numPrice(row.l),
		dayOpen: numPrice(row.o),
		prevClose: null,
		timestamp: numTimestampSeconds(row.t),
		volume: numVolume(row.v),
	};
}
