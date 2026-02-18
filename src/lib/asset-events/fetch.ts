import type { Logger } from "../logging";
import type { ProviderResult } from "../providers/massive";
import {
	fetchDividends,
	fetchEarnings,
	fetchIpos,
	fetchSplits,
} from "../providers/massive";
import type { SupabaseAdminClient } from "../schedule/helpers";

/** Number of weeks to retain in the asset_events table. */
const RETENTION_WEEKS = 4;

/**
 * Fetch earnings (Finnhub) plus dividends/splits/IPOs (Massive) for the given week,
 * filter calendar events to symbols tracked by any user, and upsert into the
 * `asset_events` table. IPOs are stored market-wide (not watchlist-scoped).
 *
 * Deduplication is handled by the DB unique index `(symbol, event_type, event_date)`
 * via upsert, so this function is safe to call repeatedly for the same week.
 * Cleans up rows older than RETENTION_WEEKS.
 */
export async function fetchAndStoreAssetEvents(options: {
	supabase: SupabaseAdminClient;
	weekStart: string; // YYYY-MM-DD (Monday)
	weekEnd: string; // YYYY-MM-DD (Friday)
	logger: Logger;
}): Promise<{ upserted: number; failedProviders: string[] }> {
	const { supabase, weekStart, weekEnd, logger } = options;

	// Get distinct symbols tracked by any user
	const { data: trackedSymbols, error: symbolsError } = await supabase
		.from("user_assets")
		.select("symbol");

	if (symbolsError) {
		logger.error("Failed to load tracked symbols", {
			action: "fetch_asset_events",
			error: symbolsError.message,
		});
		throw new Error(`Failed to load tracked symbols: ${symbolsError.message}`);
	}

	const symbolSet = new Set((trackedSymbols ?? []).map((row) => row.symbol));
	const hasTrackedSymbols = symbolSet.size > 0;

	// Fetch all four event types from providers:
	// - earnings from Finnhub
	// - dividends/splits/IPOs from Massive
	const emptyResult: ProviderResult<never> = { data: [], failed: false };
	const [earningsResult, dividendsResult, splitsResult, iposResult] =
		await Promise.all([
			hasTrackedSymbols
				? fetchEarnings(weekStart, weekEnd)
				: Promise.resolve(emptyResult),
			hasTrackedSymbols
				? fetchDividends(weekStart, weekEnd)
				: Promise.resolve(emptyResult),
			hasTrackedSymbols
				? fetchSplits(weekStart, weekEnd)
				: Promise.resolve(emptyResult),
			fetchIpos(weekStart, weekEnd),
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
		logger.warn("One or more asset event providers failed", {
			action: "fetch_asset_events",
			failedProviders,
		});
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
	// IPOs are intentionally global and should not depend on tracked symbols.
	type AssetEventInsert = {
		symbol: string;
		event_type: "earnings" | "dividend" | "split" | "ipo";
		scope: "watchlist" | "global";
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
			scope: "watchlist",
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
			scope: "watchlist",
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
			scope: "watchlist",
			event_date: s.executionDate,
			data: {
				splitFrom: s.splitFrom,
				splitTo: s.splitTo,
				adjustmentType: s.adjustmentType,
			},
			week_of: weekStart,
		});
	}

	for (const ipo of ipos) {
		rows.push({
			symbol: ipo.ticker,
			event_type: "ipo",
			scope: "global",
			event_date: ipo.listingDate,
			data: {
				issuerName: ipo.issuerName,
				securityType: ipo.securityType,
			},
			week_of: weekStart,
		});
	}

	if (rows.length > 0) {
		const { error: insertError } = await supabase
			.from("asset_events")
			.upsert(rows, {
				// Matches DB unique index (week_of is not part of uniqueness)
				onConflict: "symbol,event_type,event_date",
			});

		if (insertError) {
			logger.error("Failed to insert asset_events", {
				action: "fetch_asset_events",
				weekStart,
				rowCount: rows.length,
				error: insertError.message,
			});
			throw new Error(
				`Failed to insert asset_events for ${weekStart}: ${insertError.message}`,
			);
		}
	}

	logger.info("Asset events stored", {
		action: "fetch_asset_events",
		weekStart,
		upserted: rows.length,
	});

	// Cleanup old rows
	const cutoff = new Date();
	// Use UTC explicitly to avoid timezone-dependent cutoffs.
	cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_WEEKS * 7);
	const cutoffDate = cutoff.toISOString().slice(0, 10);

	const { error: deleteError } = await supabase
		.from("asset_events")
		.delete()
		.lt("week_of", cutoffDate);

	if (deleteError) {
		logger.warn("Failed to clean up old asset_events rows", {
			action: "fetch_asset_events",
			cutoffDate,
			error: deleteError.message,
		});
	}

	return { upserted: rows.length, failedProviders };
}
