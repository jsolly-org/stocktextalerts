import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging/types";
import { fetchDividends, fetchIpos, fetchSplits } from "./corporate-actions";
import { fetchEarnings } from "./earnings";
import type { AssetEventProvider, ProviderResult } from "./types";

/** Number of weeks to retain in the asset_events / market_events tables. */
const RETENTION_WEEKS = 4;

const ALL_ASSET_EVENT_PROVIDERS: AssetEventProvider[] = ["earnings", "dividends", "splits", "ipos"];

/**
 * Fetch earnings (Finnhub) plus dividends/splits/IPOs (Massive) for the given week,
 * filter calendar events to symbols tracked by any user, and upsert into the
 * `asset_events` table. IPOs go into `market_events` (no FK to `assets`).
 *
 * Deduplication is handled by DB unique indexes via upsert, so this function
 * is safe to call repeatedly for the same week.
 * Cleans up rows older than RETENTION_WEEKS.
 */
export async function fetchAndStoreAssetEvents(options: {
	supabase: SupabaseAdminClient;
	weekStart: string; // YYYY-MM-DD (Monday)
	weekEnd: string; // YYYY-MM-DD (Friday)
	logger: Logger;
	providers?: AssetEventProvider[];
}): Promise<{ upserted: number; failedProviders: string[] }> {
	const { supabase, weekStart, weekEnd, logger, providers } = options;
	const requestedProviders = providers ?? ALL_ASSET_EVENT_PROVIDERS;
	const shouldFetch = (provider: AssetEventProvider) => requestedProviders.includes(provider);

	// Get distinct symbols tracked by any user
	const { data: trackedSymbols, error: symbolsError } = await supabase
		.from("user_assets")
		.select("symbol");

	if (symbolsError) {
		logger.error("Failed to load tracked symbols", { action: "fetch_asset_events" }, symbolsError);
		throw new Error(`Failed to load tracked symbols: ${symbolsError.message}`);
	}

	const symbolSet = new Set((trackedSymbols ?? []).map((row) => row.symbol));
	const hasTrackedSymbols = symbolSet.size > 0;

	// Earnings (Finnhub) first — it can block ~80s on retry exhaustion. Massive
	// responses (up to 1000 dividends) are large; fetching them in parallel with
	// a stalled Finnhub call pinned memory at 256 MB and OOM'd the Lambda.
	const emptyResult: ProviderResult<never> = { data: [], failed: false };
	const earningsResult =
		hasTrackedSymbols && shouldFetch("earnings")
			? await fetchEarnings(weekStart, weekEnd)
			: emptyResult;

	const [dividendsResult, splitsResult, iposResult] = await Promise.all([
		hasTrackedSymbols && shouldFetch("dividends")
			? fetchDividends(weekStart, weekEnd)
			: Promise.resolve(emptyResult),
		hasTrackedSymbols && shouldFetch("splits")
			? fetchSplits(weekStart, weekEnd)
			: Promise.resolve(emptyResult),
		shouldFetch("ipos") ? fetchIpos(weekStart, weekEnd) : Promise.resolve(emptyResult),
	]);

	const earnings = earningsResult.data;
	const dividends = dividendsResult.data;
	const splits = splitsResult.data;
	const ipos = iposResult.data;

	const failedProviders: string[] = [];
	if (earningsResult.failed) failedProviders.push("earnings");
	if (dividendsResult.failed) failedProviders.push("dividends");
	if (splitsResult.failed) failedProviders.push("splits");
	if (iposResult.failed) failedProviders.push("ipos");

	if (failedProviders.length > 0) {
		logger.error(
			"One or more asset event providers failed",
			{ action: "fetch_asset_events", failedProviders },
			new Error(`Failed providers: ${failedProviders.join(", ")}`),
		);
	}

	logger.info("Provider responses received", {
		action: "fetch_asset_events",
		weekStart,
		earningsTotal: earnings.length,
		dividendsTotal: dividends.length,
		splitsTotal: splits.length,
		iposTotal: ipos.length,
		trackedSymbols: symbolSet.size,
	});

	// Filter calendar events to tracked symbols and build insert rows.
	type AssetEventInsert = {
		symbol: string;
		event_type: "earnings" | "dividend" | "split";
		event_date: string;
		data: Record<string, string | number | null>;
		week_of: string;
	};

	const rows: AssetEventInsert[] = [];

	for (const e of earnings) {
		if (!symbolSet.has(e.ticker)) continue;
		rows.push({
			symbol: e.ticker,
			event_type: "earnings",
			event_date: e.date,
			data: {
				time: e.time,
				epsEstimate: e.epsEstimate,
				revenueEstimate: e.revenueEstimate,
			},
			week_of: weekStart,
		});
	}

	for (const d of dividends) {
		if (!symbolSet.has(d.ticker)) continue;
		rows.push({
			symbol: d.ticker,
			event_type: "dividend",
			event_date: d.exDividendDate,
			data: {
				cashAmount: d.cashAmount,
				currency: d.currency,
				payDate: d.payDate,
				frequency: d.frequency,
			},
			week_of: weekStart,
		});
	}

	for (const s of splits) {
		if (!symbolSet.has(s.ticker)) continue;
		rows.push({
			symbol: s.ticker,
			event_type: "split",
			event_date: s.executionDate,
			data: {
				splitFrom: s.splitFrom,
				splitTo: s.splitTo,
				adjustmentType: s.adjustmentType,
			},
			week_of: weekStart,
		});
	}

	// Build IPO rows for market_events table (no FK constraint on symbol)
	type MarketEventInsert = {
		event_type: "ipo";
		symbol: string;
		event_date: string;
		week_of: string;
		data: Record<string, string | number | null>;
	};

	const ipoRows: MarketEventInsert[] = ipos.map((ipo) => ({
		event_type: "ipo",
		symbol: ipo.ticker,
		event_date: ipo.listingDate,
		week_of: weekStart,
		data: {
			issuerName: ipo.issuerName,
			securityType: ipo.securityType,
		},
	}));

	// Upsert calendar events into asset_events
	if (rows.length > 0) {
		const { error: insertError } = await supabase.from("asset_events").upsert(rows, {
			onConflict: "symbol,event_type,event_date",
		});

		if (insertError) {
			logger.error(
				"Failed to insert asset_events",
				{ action: "fetch_asset_events", weekStart, rowCount: rows.length },
				insertError,
			);
			throw new Error(`Failed to insert asset_events for ${weekStart}: ${insertError.message}`);
		}
	}

	// Upsert IPOs into market_events
	if (ipoRows.length > 0) {
		const { error: ipoError } = await supabase.from("market_events").upsert(ipoRows, {
			onConflict: "event_type,symbol,event_date",
		});

		if (ipoError) {
			logger.error(
				"Failed to insert market_events (IPOs)",
				{ action: "fetch_asset_events", weekStart, rowCount: ipoRows.length },
				ipoError,
			);
			throw new Error(`Failed to insert market_events for ${weekStart}: ${ipoError.message}`);
		}
	}

	const totalUpserted = rows.length + ipoRows.length;

	logger.info("Asset events stored", {
		action: "fetch_asset_events",
		weekStart,
		upserted: totalUpserted,
	});

	// Cleanup old rows
	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_WEEKS * 7);
	const cutoffDate = cutoff.toISOString().slice(0, 10);

	const [assetDeleteResult, marketDeleteResult] = await Promise.all([
		supabase.from("asset_events").delete().lt("week_of", cutoffDate),
		supabase.from("market_events").delete().lt("week_of", cutoffDate),
	]);

	if (assetDeleteResult.error) {
		logger.error(
			"Failed to clean up old asset_events rows",
			{ action: "fetch_asset_events", cutoffDate },
			assetDeleteResult.error,
		);
	}

	if (marketDeleteResult.error) {
		logger.error(
			"Failed to clean up old market_events rows",
			{ action: "fetch_asset_events", cutoffDate },
			marketDeleteResult.error,
		);
	}

	return { upserted: totalUpserted, failedProviders };
}
