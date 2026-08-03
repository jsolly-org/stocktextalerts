/**
 * Nightly Massive short-interest ingest + send-time loaders for the
 * Asset Events `short_interest` facet.
 */
import { DateTime } from "luxon";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { isRecord } from "../types";
import { marketDataFetch } from "../vendors/massive";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "../vendors/optional-vendors";
import {
	getNextFinraShortInterestCycle,
	isFinraPublishInCalendarWindow,
} from "./finra-short-interest-calendar";
import type { ShortInterestDigestContent, ShortInterestLine } from "./types";

const SHORT_INTEREST_RETENTION_DAYS = 120;
const SHORT_INTEREST_TICKER_CHUNK = 40;
const SHARES_OUTSTANDING_CONCURRENCY = 8;

const optionalMassivePolicy = { optional: true } as const;

type MassiveShortInterestRow = {
	ticker: string;
	settlement_date: string;
	short_interest: number;
	avg_daily_volume: number | null;
	days_to_cover: number | null;
};

function parseShortInterestResults(payload: unknown): MassiveShortInterestRow[] {
	if (!isRecord(payload) || !Array.isArray(payload.results)) return [];
	const rows: MassiveShortInterestRow[] = [];
	for (const item of payload.results) {
		if (!isRecord(item)) continue;
		const ticker = typeof item.ticker === "string" ? item.ticker.trim().toUpperCase() : "";
		const settlement_date =
			typeof item.settlement_date === "string" ? item.settlement_date.slice(0, 10) : "";
		const short_interest =
			typeof item.short_interest === "number" && Number.isFinite(item.short_interest)
				? Math.trunc(item.short_interest)
				: null;
		if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(settlement_date) || short_interest === null) {
			continue;
		}
		const avg_daily_volume =
			typeof item.avg_daily_volume === "number" && Number.isFinite(item.avg_daily_volume)
				? Math.trunc(item.avg_daily_volume)
				: null;
		const days_to_cover =
			typeof item.days_to_cover === "number" && Number.isFinite(item.days_to_cover)
				? item.days_to_cover
				: null;
		rows.push({ ticker, settlement_date, short_interest, avg_daily_volume, days_to_cover });
	}
	return rows;
}

async function fetchLatestShortInterestForTickers(
	tickers: string[],
	logger: Logger,
): Promise<{ rows: MassiveShortInterestRow[]; failures: string[] }> {
	const failures: string[] = [];
	const latestByTicker = new Map<string, MassiveShortInterestRow>();

	for (let i = 0; i < tickers.length; i += SHORT_INTEREST_TICKER_CHUNK) {
		const chunk = tickers.slice(i, i + SHORT_INTEREST_TICKER_CHUNK);
		const payload = await marketDataFetch(
			"/stocks/v1/short-interest",
			{
				"ticker.any_of": chunk.join(","),
				limit: "500",
				sort: "settlement_date.desc",
			},
			"short-interest",
			{ tickerCount: chunk.length },
			optionalMassivePolicy,
		);
		if (payload === null) {
			failures.push(`short_interest_chunk:${chunk[0]}`);
			logger.warn("Massive short-interest chunk failed", {
				action: "fetch_short_interest",
				chunkStart: chunk[0],
				chunkSize: chunk.length,
				category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
			});
			continue;
		}
		for (const row of parseShortInterestResults(payload)) {
			const existing = latestByTicker.get(row.ticker);
			if (!existing || row.settlement_date > existing.settlement_date) {
				latestByTicker.set(row.ticker, row);
			}
		}
	}

	return { rows: [...latestByTicker.values()], failures };
}

async function fetchShareClassSharesOutstanding(symbol: string): Promise<number | null> {
	const payload = await marketDataFetch(
		`/v3/reference/tickers/${encodeURIComponent(symbol)}`,
		{},
		"ticker-detail-shares",
		{ symbol },
		optionalMassivePolicy,
	);
	if (!isRecord(payload) || !isRecord(payload.results)) return null;
	const results = payload.results;
	const shareClass = results.share_class_shares_outstanding;
	if (typeof shareClass === "number" && Number.isFinite(shareClass) && shareClass > 0) {
		return Math.trunc(shareClass);
	}
	const weighted = results.weighted_shares_outstanding;
	if (typeof weighted === "number" && Number.isFinite(weighted) && weighted > 0) {
		return Math.trunc(weighted);
	}
	return null;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await fn(items[index] as T);
		}
	}
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * Fetch latest FINRA short interest (via Massive) for every tracked symbol and upsert.
 */
export async function fetchAndStoreShortInterest(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<{ upserted: number; failures: string[] }> {
	const { supabase, logger } = options;
	const failures: string[] = [];

	const { data: trackedRows, error: symbolsError } = await supabase
		.from("user_assets")
		.select("symbol");

	if (symbolsError) {
		logger.error(
			"Failed to load tracked symbols for short interest",
			{ action: "fetch_short_interest" },
			symbolsError,
		);
		throw new Error(`Failed to load tracked symbols: ${symbolsError.message}`);
	}

	const symbols = [...new Set((trackedRows ?? []).map((row) => row.symbol))];
	if (symbols.length === 0) {
		return { upserted: 0, failures: [] };
	}

	const { rows, failures: fetchFailures } = await fetchLatestShortInterestForTickers(
		symbols,
		logger,
	);
	failures.push(...fetchFailures);

	if (rows.length === 0) {
		logger.warn("No Massive short-interest rows to upsert", {
			action: "fetch_short_interest",
			trackedSymbols: symbols.length,
			category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
		});
		return { upserted: 0, failures };
	}

	const sharesBySymbol = new Map<string, number | null>();
	const shareResults = await mapWithConcurrency(
		rows,
		SHARES_OUTSTANDING_CONCURRENCY,
		async (row) => {
			const shares = await fetchShareClassSharesOutstanding(row.ticker);
			return { ticker: row.ticker, shares };
		},
	);
	for (const result of shareResults) {
		sharesBySymbol.set(result.ticker, result.shares);
	}

	const upsertRows = rows.map((row) => ({
		symbol: row.ticker,
		settlement_date: row.settlement_date,
		short_interest: row.short_interest,
		avg_daily_volume: row.avg_daily_volume,
		days_to_cover: row.days_to_cover,
		share_class_shares_outstanding: sharesBySymbol.get(row.ticker) ?? null,
		fetched_at: new Date().toISOString(),
	}));

	const { error: upsertError } = await supabase.from("asset_short_interest").upsert(upsertRows, {
		onConflict: "symbol,settlement_date",
	});

	if (upsertError) {
		logger.error(
			"Failed to upsert asset_short_interest",
			{ action: "fetch_short_interest", rowCount: upsertRows.length },
			upsertError,
		);
		failures.push("short_interest_upsert");
		return { upserted: 0, failures };
	}

	const pruneBefore = DateTime.utc().minus({ days: SHORT_INTEREST_RETENTION_DAYS }).toISODate();
	if (pruneBefore) {
		const { error: pruneError } = await supabase
			.from("asset_short_interest")
			.delete()
			.lt("settlement_date", pruneBefore);
		if (pruneError) {
			logger.error(
				"Failed to prune old asset_short_interest",
				{ action: "fetch_short_interest", pruneBefore },
				pruneError,
			);
			failures.push("short_interest_prune");
		}
	}

	const summary = {
		action: "fetch_short_interest" as const,
		trackedSymbols: symbols.length,
		upserted: upsertRows.length,
		failureCount: failures.length,
		failures,
	};
	if (failures.length > 0) {
		logger.warn("Short interest ingest completed with failures", {
			...summary,
			category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
		});
	} else {
		logger.info("Short interest ingest complete", summary);
	}

	return { upserted: upsertRows.length, failures };
}

function formatPctOfShares(shortInterest: number, sharesOutstanding: number | null): string | null {
	if (sharesOutstanding === null || sharesOutstanding <= 0) return null;
	const pct = (shortInterest / sharesOutstanding) * 100;
	if (!Number.isFinite(pct)) return null;
	return `${pct.toFixed(1)}% of shares`;
}

function formatDaysToCover(daysToCover: number | null): string | null {
	if (daysToCover === null || !Number.isFinite(daysToCover)) return null;
	return `${daysToCover.toFixed(1)} days to cover`;
}

function formatSettlementLabel(isoDate: string): string {
	const dt = DateTime.fromISO(isoDate, { zone: "utc" });
	if (!dt.isValid) return isoDate;
	return dt.toFormat("MMM d");
}

/**
 * Build digest content when a FINRA publish date falls in the next-3-days window.
 * Heads-up before publish day (or when settlement rows are missing); numbers on publish day.
 */
export async function loadShortInterestDigestContent(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	tickers: readonly string[];
	localDate: string;
}): Promise<ShortInterestDigestContent | null> {
	const { supabase, logger, tickers, localDate } = options;
	const cycle = getNextFinraShortInterestCycle(localDate);
	if (!cycle || !isFinraPublishInCalendarWindow(localDate, cycle.publishDate)) {
		return null;
	}

	if (localDate < cycle.publishDate || tickers.length === 0) {
		return {
			mode: "heads_up",
			publishDate: cycle.publishDate,
			settlementDate: cycle.settlementDate,
			lines: null,
		};
	}

	const { data, error } = await supabase
		.from("asset_short_interest")
		.select(
			"symbol, settlement_date, short_interest, days_to_cover, share_class_shares_outstanding",
		)
		.in("symbol", [...tickers])
		.eq("settlement_date", cycle.settlementDate);

	if (error) {
		logger.error(
			"Failed to load asset_short_interest for digest",
			{ action: "load_short_interest", localDate, settlementDate: cycle.settlementDate },
			error,
		);
		return {
			mode: "heads_up",
			publishDate: cycle.publishDate,
			settlementDate: cycle.settlementDate,
			lines: null,
		};
	}

	const bySymbol = new Map((data ?? []).map((row) => [row.symbol, row]));
	const lines: ShortInterestLine[] = [];
	for (const symbol of tickers) {
		const row = bySymbol.get(symbol);
		if (!row) continue;
		const pct = formatPctOfShares(row.short_interest, row.share_class_shares_outstanding);
		const dtc = formatDaysToCover(
			typeof row.days_to_cover === "number" ? Number(row.days_to_cover) : null,
		);
		const parts = [pct, dtc].filter((part): part is string => Boolean(part));
		if (parts.length === 0) {
			lines.push({
				symbol,
				text: `${symbol} — ${row.short_interest.toLocaleString("en-US")} shares short`,
			});
			continue;
		}
		lines.push({ symbol, text: `${symbol} — ${parts.join(" · ")}` });
	}

	if (lines.length === 0) {
		return {
			mode: "heads_up",
			publishDate: cycle.publishDate,
			settlementDate: cycle.settlementDate,
			lines: null,
		};
	}

	return {
		mode: "report",
		publishDate: cycle.publishDate,
		settlementDate: cycle.settlementDate,
		lines,
	};
}

/** Format short-interest section body (without the section title). */
function formatShortInterestSectionBody(content: ShortInterestDigestContent): string {
	if (content.mode === "heads_up" || !content.lines?.length) {
		return [
			`FINRA publishes the next short-interest report on ${formatSettlementLabel(content.publishDate)}`,
			`(settlement ${formatSettlementLabel(content.settlementDate)})`,
		].join("\n");
	}
	const header = `as of ${formatSettlementLabel(content.settlementDate)} · published ${formatSettlementLabel(content.publishDate)}`;
	return [`(${header})`, ...content.lines.map((line) => line.text)].join("\n");
}

/** Section title for report mode includes the as-of subtitle on the same conceptual block. */
export function formatShortInterestSectionTitle(content: ShortInterestDigestContent): string {
	if (content.mode === "report" && content.lines?.length) {
		return `Short Interest (as of ${formatSettlementLabel(content.settlementDate)} · published ${formatSettlementLabel(content.publishDate)})`;
	}
	return "Short Interest";
}

/** Body lines only for report mode (title carries the as-of). */
export function formatShortInterestSectionLines(content: ShortInterestDigestContent): string {
	if (content.mode === "report" && content.lines?.length) {
		return content.lines.map((line) => line.text).join("\n");
	}
	return formatShortInterestSectionBody(content);
}
