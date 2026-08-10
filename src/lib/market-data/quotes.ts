import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import type { ExtendedAssetQuote, MarketSession, NoSessionTrade } from "../types";
import { isRecord, NO_SESSION_TRADE } from "../types";
import { marketDataFetch } from "../vendors/massive";

/** Massive unified-snapshot `market_status` values for stocks. */
type SnapshotMarketStatus = "open" | "closed" | "early_trading" | "late_trading";

/** Massive unified snapshot (`GET /v3/snapshot`) stock result we parse for quotes. */
interface UnifiedSnapshotResult {
	ticker: string;
	error?: string;
	market_status?: string;
	session?: {
		open?: number;
		high?: number;
		low?: number;
		close?: number;
		volume?: number;
		previous_close?: number;
		last_updated?: number;
	};
	last_minute?: {
		close?: number;
		last_updated?: number;
	};
}

const SNAPSHOT_QUOTES_MAX_TICKERS_PER_REQUEST = 250;
const SNAPSHOT_QUOTES_LARGE_BATCH_TIMEOUT_MS = 35_000;
const SNAPSHOT_QUOTES_CHUNK_CONCURRENCY = 2;

function positiveOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function volumeOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Convert Massive nanosecond timestamps to unix seconds. */
function snapshotTimestampSeconds(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value / 1_000_000_000)
		: null;
}

function parseMarketStatus(value: unknown): SnapshotMarketStatus | null {
	if (
		value === "open" ||
		value === "closed" ||
		value === "early_trading" ||
		value === "late_trading"
	) {
		return value;
	}
	return null;
}

/**
 * Session-aware price from a v3 unified snapshot.
 *
 * v3 `last_minute` has no bar-period timestamp (v2's `min.t`). Its `last_updated`
 * is a refresh clock and runs ~15 minutes ahead of entitled Starter data, so it
 * must not gate session attribution. Use Massive's `market_status` instead, and
 * never fall back to `last_minute` during regular hours (that would accept delayed
 * pre-market prints right after the open while `session.close` is still empty).
 */
function parseUnifiedSnapshotResult(
	result: UnifiedSnapshotResult,
	session: MarketSession,
): ExtendedAssetQuote | NoSessionTrade | null {
	const sessionBar = result.session;
	const minuteBar = result.last_minute;
	const dayPrice = positiveOrNull(sessionBar?.close);
	const minutePrice = positiveOrNull(minuteBar?.close);
	const marketStatus = parseMarketStatus(result.market_status);
	let price: number | null;

	switch (session) {
		case "pre":
			price = marketStatus === "early_trading" ? minutePrice : null;
			break;
		case "after":
			price = marketStatus === "late_trading" ? minutePrice : dayPrice;
			break;
		case "regular":
			price = dayPrice;
			break;
		case "closed":
			price = dayPrice;
			break;
	}

	if (price === null) {
		return NO_SESSION_TRADE;
	}

	const prevClose = positiveOrNull(sessionBar?.previous_close);
	if (prevClose === null) {
		return null;
	}
	const changePercent = ((price - prevClose) / prevClose) * 100;
	if (!Number.isFinite(changePercent)) {
		return null;
	}

	return {
		price,
		changePercent,
		dayHigh: positiveOrNull(sessionBar?.high),
		dayLow: positiveOrNull(sessionBar?.low),
		dayOpen: positiveOrNull(sessionBar?.open),
		prevClose,
		timestamp: snapshotTimestampSeconds(sessionBar?.last_updated ?? null),
		volume: volumeOrNull(sessionBar?.volume),
	};
}

function chunkSymbols(symbols: string[], chunkSize: number): string[][] {
	const chunks: string[][] = [];
	for (let index = 0; index < symbols.length; index += chunkSize) {
		chunks.push(symbols.slice(index, index + chunkSize));
	}
	return chunks;
}

async function fetchSnapshotQuotesChunk(options: {
	symbols: string[];
	session: MarketSession;
	chunkIndex: number;
	chunkCount: number;
	totalTickerCount: number;
}): Promise<Map<string, ExtendedAssetQuote | NoSessionTrade | null>> {
	const { symbols, session, chunkIndex, chunkCount, totalTickerCount } = options;
	const chunkResult = new Map<string, ExtendedAssetQuote | NoSessionTrade | null>();
	for (const symbol of symbols) {
		chunkResult.set(symbol, null);
	}

	const policy =
		symbols.length >= SNAPSHOT_QUOTES_MAX_TICKERS_PER_REQUEST
			? { requestTimeoutMs: SNAPSHOT_QUOTES_LARGE_BATCH_TIMEOUT_MS }
			: undefined;
	// Unified snapshot (v3). Do not pass `type` together with ticker filters —
	// Massive rejects that combination. Always set `limit` (API default is 10).
	const data = await marketDataFetch(
		"/v3/snapshot",
		{
			"ticker.any_of": symbols.join(","),
			limit: String(symbols.length),
		},
		"snapshot-quotes",
		{ tickerCount: totalTickerCount, chunkIndex, chunkCount },
		policy,
	);
	// Fetch failures already logged in marketDataFetch (often vendor_retry_exhausted).
	// Do not re-log as "unexpected payload" — that bypasses ErrorLogAlarm exclusions.
	if (data === null) {
		return chunkResult;
	}
	if (!isRecord(data) || !Array.isArray(data.results)) {
		rootLogger.error("Snapshot quote chunk returned unexpected payload shape", {
			chunkIndex,
			chunkCount,
			tickerCount: symbols.length,
			hasRecord: isRecord(data),
			resultsType: isRecord(data) ? typeof data.results : "n/a",
		});
		return chunkResult;
	}

	for (const rawResult of data.results) {
		if (!isRecord(rawResult) || typeof rawResult.ticker !== "string") {
			continue;
		}
		if (!chunkResult.has(rawResult.ticker)) {
			continue;
		}
		// Per-ticker NOT_FOUND / errors stay null (miss), not NO_SESSION_TRADE.
		if (typeof rawResult.error === "string" && rawResult.error.length > 0) {
			continue;
		}
		chunkResult.set(
			rawResult.ticker,
			parseUnifiedSnapshotResult(rawResult as unknown as UnifiedSnapshotResult, session),
		);
	}
	return chunkResult;
}

/**
 * Fetch Massive unified snapshots (`GET /v3/snapshot`). Every requested symbol is
 * pre-seeded in the result: `null` means the fetch missed it, while `NO_SESSION_TRADE`
 * means Massive recognized it but there is no price attributable to the requested session.
 */
export async function fetchSnapshotQuotes(
	symbols: string[],
	session: MarketSession,
): Promise<Map<string, ExtendedAssetQuote | NoSessionTrade | null>> {
	const result = new Map<string, ExtendedAssetQuote | NoSessionTrade | null>();
	if (symbols.length === 0) return result;

	for (const symbol of symbols) {
		result.set(symbol, null);
	}

	const chunks = chunkSymbols(symbols, SNAPSHOT_QUOTES_MAX_TICKERS_PER_REQUEST);
	const queue = chunks.map((chunk, index) => ({ chunk, chunkIndex: index + 1 }));
	async function worker(): Promise<void> {
		for (;;) {
			const next = queue.shift();
			if (next === undefined) break;
			try {
				const chunkResult = await fetchSnapshotQuotesChunk({
					symbols: next.chunk,
					session,
					chunkIndex: next.chunkIndex,
					chunkCount: chunks.length,
					totalTickerCount: symbols.length,
				});
				for (const [symbol, entry] of chunkResult) {
					result.set(symbol, entry);
				}
			} catch (error) {
				rootLogger.error(
					"Snapshot quote chunk failed",
					{
						chunkIndex: next.chunkIndex,
						chunkCount: chunks.length,
						tickerCount: next.chunk.length,
					},
					createErrorForLogging(error),
				);
			}
		}
	}

	const workers: Promise<void>[] = [];
	for (let index = 0; index < Math.min(SNAPSHOT_QUOTES_CHUNK_CONCURRENCY, queue.length); index++) {
		workers.push(worker());
	}
	await Promise.all(workers);
	return result;
}

/** Fetch the latest completed daily bar for closed-session snapshot misses. */
export async function fetchPrevDayBar(symbol: string): Promise<ExtendedAssetQuote | null> {
	const data = await marketDataFetch(
		`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`,
		{ adjusted: "true" },
		"prev-day-bar",
	);
	if (!isRecord(data) || !Array.isArray(data.results) || data.results.length === 0) {
		return null;
	}
	const row = data.results[0];
	if (!isRecord(row)) {
		return null;
	}

	const close = positiveOrNull(row.c);
	if (close === null) {
		return null;
	}
	const timestamp =
		typeof row.t === "number" && Number.isFinite(row.t) && row.t > 0
			? Math.floor(row.t / 1000)
			: null;
	return {
		price: close,
		changePercent: 0,
		dayHigh: positiveOrNull(row.h),
		dayLow: positiveOrNull(row.l),
		dayOpen: positiveOrNull(row.o),
		prevClose: null,
		timestamp,
		volume: volumeOrNull(row.v),
	};
}
