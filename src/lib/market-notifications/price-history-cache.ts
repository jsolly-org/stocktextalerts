import { DateTime } from "luxon";
import { SECTOR_ETF_MAP } from "../assets/sector-mapping";
import { US_MARKET_TIMEZONE } from "../constants";
import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import type { ExtendedQuoteMap } from "../market-data/types";
import { downsampleEvenly, type SparklineData, toSparkline } from "../messaging/sparkline";
import type { SupabaseAdminClient } from "../schedule/helpers";
import type { DailyOHLCVBar } from "../vendors/massive/aggregates";

const MINUTE_RETENTION_HOURS = 36;
const DAILY_RETENTION_DAYS = 30;
export const INTRADAY_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
export const REQUIRED_DAILY_CLOSES = 7;

const MARKET_BENCHMARK_SYMBOL = "SPY";

export type PriceHistoryRow = {
	symbol: string;
	price: number;
	captured_at: string;
};

type DailyCloseRow = {
	symbol: string;
	trading_date: string;
	close: number;
};

/** Benchmark + sector ETF symbols used for price-alert context charts. */
export function getBenchmarkCacheSymbols(): string[] {
	return [MARKET_BENCHMARK_SYMBOL, ...new Set(Object.values(SECTOR_ETF_MAP))];
}

export async function getPriceCacheSymbols(supabase: SupabaseAdminClient): Promise<string[]> {
	const { data, error } = await supabase.from("user_assets").select("symbol");
	if (error) {
		rootLogger.error("Failed to load tracked symbols for price cache", {}, error);
		return getBenchmarkCacheSymbols();
	}
	const symbols = new Set(getBenchmarkCacheSymbols());
	for (const row of data ?? []) {
		symbols.add(row.symbol);
	}
	return [...symbols];
}

export function listTradingDatesBetween(from: string, to: string): string[] {
	const start = DateTime.fromISO(from, { zone: US_MARKET_TIMEZONE });
	const end = DateTime.fromISO(to, { zone: US_MARKET_TIMEZONE });
	if (!start.isValid || !end.isValid) return [];
	const dates: string[] = [];
	let day = start.startOf("day");
	const endDay = end.startOf("day");
	while (day <= endDay) {
		if (day.weekday <= 5) {
			const iso = day.toISODate();
			if (iso) dates.push(iso);
		}
		day = day.plus({ days: 1 });
	}
	return dates;
}

export function formatChartAsOfLabel(
	isoTimestamp: string,
	timezone: string,
	use24HourTime: boolean,
): string {
	const dt = DateTime.fromISO(isoTimestamp, { zone: "utc" }).setZone(timezone);
	if (!dt.isValid) return "";
	const formatted = dt.toLocaleString({
		hour: "numeric",
		minute: "2-digit",
		hour12: !use24HourTime,
		timeZoneName: "short",
	});
	return `chart as of ${formatted}`;
}

export async function storePriceHistoryRows(
	supabase: SupabaseAdminClient,
	rows: PriceHistoryRow[],
): Promise<boolean> {
	if (rows.length === 0) return true;
	try {
		const { error } = await supabase.from("asset_price_history").insert(
			rows.map((row) => ({
				symbol: row.symbol,
				price: row.price,
				captured_at: row.captured_at,
			})),
		);
		if (error) {
			rootLogger.error("Failed to insert asset_price_history rows", { count: rows.length }, error);
			return false;
		}
		return true;
	} catch (error) {
		rootLogger.error(
			"Failed to insert asset_price_history rows",
			{ count: rows.length },
			createErrorForLogging(error),
		);
		return false;
	}
}

/**
 * Capture minute snapshots for sparkline fallback during active market sessions.
 * Returns captured rows when the DB insert fails so callers can enqueue backfill work.
 */
export async function storePriceHistoryMinuteSnapshots(
	supabase: SupabaseAdminClient,
	quoteMap: ExtendedQuoteMap,
	capturedAt: string = new Date().toISOString(),
): Promise<PriceHistoryRow[] | null> {
	const rows: PriceHistoryRow[] = [];
	for (const [symbol, quote] of quoteMap) {
		if (!quote || !Number.isFinite(quote.price)) continue;
		rows.push({
			symbol,
			price: quote.price,
			captured_at: capturedAt,
		});
	}
	if (rows.length === 0) return null;

	const ok = await storePriceHistoryRows(supabase, rows);
	if (!ok) {
		return rows;
	}
	return null;
}

export async function storeDailyCloseRows(
	supabase: SupabaseAdminClient,
	rows: DailyCloseRow[],
): Promise<boolean> {
	if (rows.length === 0) return true;
	try {
		const { error } = await supabase.from("asset_daily_closes").upsert(rows, {
			onConflict: "symbol,trading_date",
		});
		if (error) {
			rootLogger.error("Failed to upsert asset_daily_closes", { count: rows.length }, error);
			return false;
		}
		return true;
	} catch (error) {
		rootLogger.error(
			"Failed to upsert asset_daily_closes",
			{ count: rows.length },
			createErrorForLogging(error),
		);
		return false;
	}
}

export function dailyBarsToCloseRows(symbol: string, bars: DailyOHLCVBar[]): DailyCloseRow[] {
	return bars
		.filter(
			(bar): bar is DailyOHLCVBar & { tradingDate: string } =>
				typeof bar.tradingDate === "string" && bar.tradingDate.length > 0 && bar.close > 0,
		)
		.map((bar) => ({
			symbol,
			trading_date: bar.tradingDate,
			close: bar.close,
		}));
}

export async function purgeOldPriceHistoryCache(
	supabase: SupabaseAdminClient,
): Promise<{ minutePurged: number; dailyPurged: number }> {
	const [minuteResult, dailyResult] = await Promise.all([
		supabase.rpc("purge_old_asset_price_history", {
			p_retention_hours: MINUTE_RETENTION_HOURS,
		}),
		supabase.rpc("purge_old_asset_daily_closes", {
			p_retention_days: DAILY_RETENTION_DAYS,
		}),
	]);
	if (minuteResult.error) {
		rootLogger.error("Failed to purge asset_price_history", {}, minuteResult.error);
	}
	if (dailyResult.error) {
		rootLogger.error("Failed to purge asset_daily_closes", {}, dailyResult.error);
	}
	return {
		minutePurged: typeof minuteResult.data === "number" ? minuteResult.data : 0,
		dailyPurged: typeof dailyResult.data === "number" ? dailyResult.data : 0,
	};
}

export async function getIntradaySparklineFromCache(
	supabase: SupabaseAdminClient,
	symbol: string,
	options?: {
		timezone?: string;
		use24HourTime?: boolean;
	},
): Promise<SparklineData | null> {
	const cutoff = new Date(Date.now() - MINUTE_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
	const { data, error } = await supabase
		.from("asset_price_history")
		.select("price, captured_at")
		.eq("symbol", symbol)
		.gte("captured_at", cutoff)
		.order("captured_at", { ascending: true });

	if (error) {
		rootLogger.error("Failed to read asset_price_history", { symbol }, error);
		return null;
	}
	const rows = data ?? [];
	if (rows.length < 2) return null;

	const latestCapturedAt = rows.at(-1)?.captured_at;
	if (!latestCapturedAt) return null;
	const ageMs = Date.now() - new Date(latestCapturedAt).getTime();
	if (ageMs > INTRADAY_CACHE_MAX_AGE_MS) return null;

	const values = rows.map((row) => row.price);
	const ascii = toSparkline(downsampleEvenly(values));
	if (!ascii) return null;

	const cacheAsOfLabel =
		options?.timezone !== undefined
			? formatChartAsOfLabel(latestCapturedAt, options.timezone, options.use24HourTime ?? false)
			: undefined;

	return {
		values,
		ascii,
		window: "intraday-since-prev-close",
		cacheAsOfLabel,
	};
}

export async function getSevenDaySparklineFromCache(
	supabase: SupabaseAdminClient,
	symbol: string,
	options?: {
		timezone?: string;
		use24HourTime?: boolean;
	},
): Promise<SparklineData | null> {
	const cutoff = DateTime.now().minus({ days: DAILY_RETENTION_DAYS }).toISODate();
	if (!cutoff) return null;

	const { data, error } = await supabase
		.from("asset_daily_closes")
		.select("close, trading_date")
		.eq("symbol", symbol)
		.gte("trading_date", cutoff)
		.order("trading_date", { ascending: true });

	if (error) {
		rootLogger.error("Failed to read asset_daily_closes", { symbol }, error);
		return null;
	}
	const rows = data ?? [];
	if (rows.length < REQUIRED_DAILY_CLOSES) return null;

	const lastSeven = rows.slice(-REQUIRED_DAILY_CLOSES);
	const values = lastSeven.map((row) => row.close);
	const ascii = toSparkline(values);
	if (!ascii) return null;

	const latestDate = lastSeven.at(-1)?.trading_date;
	const cacheAsOfLabel =
		latestDate && options?.timezone !== undefined
			? formatChartAsOfLabel(
					`${latestDate}T16:00:00`,
					options.timezone,
					options.use24HourTime ?? false,
				)
			: undefined;

	return {
		values,
		ascii,
		window: "7-trading-days",
		cacheAsOfLabel,
	};
}
