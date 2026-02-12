import type { Logger } from "../logging";
import {
	fetchPolygonDividends,
	fetchPolygonEarnings,
	fetchPolygonSplits,
} from "../providers/polygon";
import type { SupabaseAdminClient } from "../schedule/helpers";

/** Number of weeks to retain in the asset_events table. */
const RETENTION_WEEKS = 4;

/**
 * Fetch earnings, dividends, and splits from Polygon.io for the given week,
 * filter to symbols tracked by any user, and upsert into the `asset_events` table.
 *
 * Skips the fetch if events for this `weekOf` already exist (idempotent).
 * Cleans up rows older than RETENTION_WEEKS.
 */
export async function fetchAndStoreAssetEvents(options: {
	supabase: SupabaseAdminClient;
	weekStart: string; // YYYY-MM-DD (Monday)
	weekEnd: string; // YYYY-MM-DD (Friday)
	logger: Logger;
}): Promise<{ inserted: number; skipped: boolean }> {
	const { supabase, weekStart, weekEnd, logger } = options;

	// Idempotency: skip if we already have events for this week
	const { count, error: countError } = await supabase
		.from("asset_events")
		.select("id", { count: "exact", head: true })
		.eq("week_of", weekStart);

	if (countError) {
		logger.error("Failed to check existing asset_events", {
			action: "fetch_asset_events",
			weekStart,
			error: countError.message,
		});
		throw new Error(
			`Failed to check existing asset_events for ${weekStart}: ${countError.message}`,
		);
	}

	if (count && count > 0) {
		logger.info("Asset events already fetched for this week, skipping", {
			action: "fetch_asset_events",
			weekStart,
			existingCount: count,
		});
		return { inserted: 0, skipped: true };
	}

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

	if (symbolSet.size === 0) {
		logger.info("No tracked symbols, skipping asset events fetch", {
			action: "fetch_asset_events",
		});
		return { inserted: 0, skipped: true };
	}

	// Fetch all three event types from Polygon (3 API calls)
	const [earnings, dividends, splits] = await Promise.all([
		fetchPolygonEarnings(weekStart, weekEnd),
		fetchPolygonDividends(weekStart, weekEnd),
		fetchPolygonSplits(weekStart, weekEnd),
	]);

	logger.info("Polygon API responses received", {
		action: "fetch_asset_events",
		weekStart,
		earningsTotal: earnings.length,
		dividendsTotal: dividends.length,
		splitsTotal: splits.length,
		trackedSymbols: symbolSet.size,
	});

	// Filter to tracked symbols and build insert rows
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
		inserted: rows.length,
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

	return { inserted: rows.length, skipped: false };
}
