/**
 * Nightly daily-close cache precompute (EventBridge: 22:00 UTC weekdays). Fetches
 * daily OHLCV from Massive for every tracked symbol and caches the daily closes in
 * `asset_daily_closes` — the source for the dashboard watchlist sparklines. Enqueues
 * vendor-backfill on fetch/store failures.
 */
import type { Context, ScheduledEvent } from "aws-lambda";
import { selectRollingWindow } from "../../lib/assets/delisting-sweep";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import { runLambda } from "../../lib/logging/request-context";
import { fetchDailyOHLCV } from "../../lib/market-data/bars";
import {
	dailyBarsToCloseRows,
	storeDailyCloseRows,
} from "../../lib/market-data/price-history-cache";
import { enqueueDailyCloseBackfill } from "../../lib/vendors/backfill/enqueue";

/** Batch size for Massive API calls — pacing itself comes from the shared 5/min limiter
 *  in `marketDataFetch`; small batches just keep per-batch logs/failures legible. */
const BATCH_SIZE = 5;

/** Delay between batches (ms). */
const BATCH_DELAY_MS = 600;

/**
 * Max symbols per nightly run. Each symbol is one Massive call at the free tier's 5/min
 * pace (~12s/call), so 40 ≈ 480s of the Lambda's 600s timeout, leaving retry headroom.
 * The run rotates deterministically through the sorted symbol list night over night
 * (`selectRollingWindow`), so an over-cap universe still gets full coverage across nights
 * instead of the same tail symbols starving on every run.
 */
const DAILY_STATS_MAX_SYMBOLS_PER_RUN = 40;

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

		const allSymbols = [...new Set((allUserAssets ?? []).map((a) => a.symbol))].sort();
		if (allSymbols.length === 0) {
			logger.info("No symbols to compute daily stats for", {
				action: "compute_daily_stats",
			});
			return;
		}
		const symbols = selectRollingWindow(
			allSymbols,
			DAILY_STATS_MAX_SYMBOLS_PER_RUN,
			Math.floor(Date.now() / 86_400_000),
		);
		if (symbols.length < allSymbols.length) {
			logger.info("Daily stats capped to nightly rolling window", {
				action: "compute_daily_stats",
				totalSymbols: allSymbols.length,
				computedTonight: symbols.length,
			});
		}

		// Date range: LOOKBACK_DAYS calendar days back to ensure ~20 trading days
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

			// Delay between batches to avoid rate limits
			if (i + BATCH_SIZE < symbols.length) {
				await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
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
