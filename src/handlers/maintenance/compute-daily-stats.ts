/**
 * Nightly daily-close cache precompute (EventBridge: 22:00 UTC weekdays). Fetches
 * daily OHLCV from Massive for every tracked symbol and caches the daily closes in
 * `asset_daily_closes` — the source for the dashboard watchlist sparklines. Enqueues
 * vendor-backfill on fetch/store failures.
 */
import type { Context, ScheduledEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import { runLambda } from "../../lib/logging/request-context";
import { fetchDailyOHLCV } from "../../lib/market-data/bars";
import {
	dailyBarsToCloseRows,
	storeDailyCloseRows,
} from "../../lib/market-data/price-history-cache";
import { enqueueDailyCloseBackfill } from "../../lib/vendors/backfill/enqueue";

/** Bounded concurrency for Massive daily-bar fetches. */
const BATCH_SIZE = 50;

/** Calendar days to fetch — the 7-trading-day sparkline needs only ~7 closes;
 *  14 days safely covers that across a holiday week. */
const LOOKBACK_DAYS = 14;

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "compute-daily-stats",
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
		});
		const supabase = createSupabaseAdminClient();

		// Get all unique tracked symbols
		const { data: allUserAssets, error: assetsError } = await supabase
			.from("user_assets")
			.select("symbol");

		if (assetsError) {
			logger.error(
				"Failed to load user_assets for daily stats",
				{ action: "compute_daily_stats" },
				assetsError,
			);
			throw new Error("Failed to load user assets");
		}

		const symbols = [...new Set((allUserAssets ?? []).map((a) => a.symbol))].sort();
		if (symbols.length === 0) {
			logger.info("No symbols to compute daily stats for", {
				action: "compute_daily_stats",
			});
			return;
		}

		// Date range: LOOKBACK_DAYS calendar days back to ensure ~7 trading days.
		const to = new Date().toISOString().slice(0, 10);
		const from = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);

		let failed = 0;
		const failedDailyCloseSymbols: string[] = [];
		const processedSymbols = new Set<string>();

		for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
			const batch = symbols.slice(i, i + BATCH_SIZE);

			const results = await Promise.allSettled(
				batch.map(async (symbol) => {
					const bars = await fetchDailyOHLCV(symbol, from, to);
					if (!bars || bars.length < 2) return null;
					return { symbol, bars };
				}),
			);

			for (const result of results) {
				if (result.status === "rejected" || result.value === null) {
					if (result.status === "rejected") {
						logger.debug("Failed to fetch OHLCV for symbol", {
							action: "compute_daily_stats",
							reason: (result.reason as Error)?.message ?? "unknown",
						});
					}
					failed++;
					continue;
				}

				const { symbol, bars } = result.value;
				processedSymbols.add(symbol);

				const closeRows = dailyBarsToCloseRows(symbol, bars);
				const storedCloses = await storeDailyCloseRows(supabase, closeRows);
				if (!storedCloses) {
					failedDailyCloseSymbols.push(symbol);
				}
			}
		}

		logger.info("Daily closes cached", {
			action: "compute_daily_stats",
			total: symbols.length,
			cached: processedSymbols.size,
			failed,
			failedDailyCloseSymbols,
		});

		if (failedDailyCloseSymbols.length > 0) {
			const enqueued = await enqueueDailyCloseBackfill({
				symbols: failedDailyCloseSymbols,
				from,
				to,
				reason: "daily_close_cache_store_failed",
			});
			if (!enqueued) {
				logger.error(
					"Failed to enqueue daily-closes vendor backfill",
					{
						action: "compute_daily_stats",
						symbols: failedDailyCloseSymbols,
					},
					new Error("SQS enqueue failed"),
				);
			}
		}

		if (failed > 0) {
			const failedSymbols = symbols.filter((symbol) => !processedSymbols.has(symbol));
			if (failedSymbols.length > 0) {
				const enqueued = await enqueueDailyCloseBackfill({
					symbols: failedSymbols,
					from,
					to,
					reason: "daily_ohlcv_fetch_failed",
				});
				if (!enqueued) {
					logger.error(
						"Failed to enqueue daily-closes vendor backfill for fetch failures",
						{
							action: "compute_daily_stats",
							symbols: failedSymbols,
						},
						new Error("SQS enqueue failed"),
					);
				}
			}
		}
	});
}
