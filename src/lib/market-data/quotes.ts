import { DateTime } from "luxon";
import {
	US_AFTER_HOURS_CLOSE_EASTERN_MINUTES,
	US_MARKET_CLOSE_EASTERN_MINUTES,
	US_MARKET_OPEN_EASTERN_MINUTES,
	US_MARKET_TIMEZONE,
	US_PREMARKET_OPEN_EASTERN_MINUTES,
} from "../constants";
import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import type { ExtendedAssetQuote, MarketSession, NoSessionTrade } from "../types";
import { isRecord, NO_SESSION_TRADE } from "../types";
import { marketDataFetch } from "../vendors/massive";

interface SnapshotTicker {
	ticker: string;
	updated?: number;
	day?: {
		o?: number;
		h?: number;
		l?: number;
		c?: number;
		v?: number;
	};
	min?: {
		c?: number;
		/** Milliseconds since epoch for the minute bar. */
		t?: number;
	};
	prevDay?: {
		c?: number;
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

function snapshotTimestampSeconds(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value / 1_000_000_000)
		: null;
}

function isMinuteBarInCurrentSession(
	minTimestamp: unknown,
	session: "pre" | "regular" | "after",
): boolean {
	if (typeof minTimestamp !== "number" || !Number.isFinite(minTimestamp) || minTimestamp <= 0) {
		return false;
	}

	const tradeTimeEt = DateTime.fromMillis(minTimestamp).setZone(US_MARKET_TIMEZONE);
	const nowEt = DateTime.now().setZone(US_MARKET_TIMEZONE);
	if (!tradeTimeEt.isValid || !nowEt.isValid || tradeTimeEt.toISODate() !== nowEt.toISODate()) {
		return false;
	}

	const minuteOfDay = tradeTimeEt.hour * 60 + tradeTimeEt.minute;
	switch (session) {
		case "pre":
			return (
				minuteOfDay >= US_PREMARKET_OPEN_EASTERN_MINUTES &&
				minuteOfDay < US_MARKET_OPEN_EASTERN_MINUTES
			);
		case "regular":
			return (
				minuteOfDay >= US_MARKET_OPEN_EASTERN_MINUTES &&
				minuteOfDay < US_MARKET_CLOSE_EASTERN_MINUTES
			);
		case "after":
			return (
				minuteOfDay >= US_MARKET_CLOSE_EASTERN_MINUTES &&
				minuteOfDay < US_AFTER_HOURS_CLOSE_EASTERN_MINUTES
			);
	}
}

function parseSnapshotTicker(
	ticker: SnapshotTicker,
	session: MarketSession,
): ExtendedAssetQuote | NoSessionTrade | null {
	const dayPrice = positiveOrNull(ticker.day?.c);
	const minutePrice = positiveOrNull(ticker.min?.c);
	let price: number | null;

	switch (session) {
		case "pre":
			price = isMinuteBarInCurrentSession(ticker.min?.t, "pre") ? minutePrice : null;
			break;
		case "after":
			price = isMinuteBarInCurrentSession(ticker.min?.t, "after") ? minutePrice : dayPrice;
			break;
		case "regular":
			// Starter quotes can lag ~15m: right after the open, day.c is often empty while
			// min is still a pre-market bar. Only accept min.c when min.t is in regular hours.
			price =
				dayPrice ?? (isMinuteBarInCurrentSession(ticker.min?.t, "regular") ? minutePrice : null);
			break;
		case "closed":
			price = dayPrice;
			break;
	}

	if (price === null) {
		return NO_SESSION_TRADE;
	}

	const prevClose = positiveOrNull(ticker.prevDay?.c);
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
		dayHigh: positiveOrNull(ticker.day?.h),
		dayLow: positiveOrNull(ticker.day?.l),
		dayOpen: positiveOrNull(ticker.day?.o),
		prevClose,
		timestamp: snapshotTimestampSeconds(ticker.updated),
		volume: volumeOrNull(ticker.day?.v),
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
	const data = await marketDataFetch(
		"/v2/snapshot/locale/us/markets/stocks/tickers",
		{ tickers: symbols.join(",") },
		"snapshot-quotes",
		{ tickerCount: totalTickerCount, chunkIndex, chunkCount },
		policy,
	);
	if (!isRecord(data) || !Array.isArray(data.tickers)) {
		rootLogger.error("Snapshot quote chunk returned unexpected payload shape", {
			chunkIndex,
			chunkCount,
			tickerCount: symbols.length,
			hasRecord: isRecord(data),
			tickersType: isRecord(data) ? typeof data.tickers : "n/a",
		});
		return chunkResult;
	}

	for (const rawTicker of data.tickers) {
		if (!isRecord(rawTicker) || typeof rawTicker.ticker !== "string") {
			continue;
		}
		if (!chunkResult.has(rawTicker.ticker)) {
			continue;
		}
		chunkResult.set(
			rawTicker.ticker,
			parseSnapshotTicker(rawTicker as unknown as SnapshotTicker, session),
		);
	}
	return chunkResult;
}

/**
 * Fetch Massive batch snapshots. Every requested symbol is pre-seeded in the result:
 * `null` means the fetch missed it, while `NO_SESSION_TRADE` means Massive recognized it
 * but there is no price attributable to the requested session.
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
