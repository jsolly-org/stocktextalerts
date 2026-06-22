import type { Context, ScheduledEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../lib/db/supabase";
import { createLogger } from "../lib/logging";
import { computeADV, computeATR } from "../lib/market-notifications/daily-stats";
import { upsertDailyStatsInChunks } from "../lib/market-notifications/daily-stats-upsert";
import {
	dailyBarsToCloseRows,
	getBenchmarkCacheSymbols,
	storeDailyCloseRows,
} from "../lib/market-notifications/price-history-cache";
import { fetchDailyOHLCV } from "../lib/providers/massive";
import { runLambda } from "../lib/run-lambda";
import { enqueueDailyCloseBackfill } from "../lib/vendor-backfill/queue";

/** Batch size for Massive API calls to stay under ~100 req/s. */
const BATCH_SIZE = 50;

/** Delay between batches (ms). */
const BATCH_DELAY_MS = 600;

/** Calendar days to fetch for ~20 trading days of data. */
const LOOKBACK_DAYS = 35;

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

		const symbols = [
			...new Set([...(allUserAssets ?? []).map((a) => a.symbol), ...getBenchmarkCacheSymbols()]),
		];
		if (symbols.length === 0) {
			logger.info("No symbols to compute daily stats for", {
				action: "compute_daily_stats",
			});
			return;
		}

		// Date range: LOOKBACK_DAYS calendar days back to ensure ~20 trading days
		const to = new Date().toISOString().slice(0, 10);
		const from = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);

		let computed = 0;
		let failed = 0;
		const failedDailyCloseSymbols: string[] = [];
		const rows: Array<{
			symbol: string;
			computed_at: string;
			avg_volume_20d: number | null;
			atr_14: number | null;
		}> = [];

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
				const adv = computeADV(bars);
				const atr = computeATR(bars);

				rows.push({
					symbol,
					computed_at: to,
					avg_volume_20d: adv !== null ? Math.round(adv) : null,
					atr_14: atr !== null ? Math.round(atr * 10000) / 10000 : null,
				});
				computed++;

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

		// Upsert all rows in independent chunks so a single chunk failure doesn't
		// discard a full day of computed stats across every symbol.
		if (rows.length > 0) {
			const upsertResult = await upsertDailyStatsInChunks(rows, async (chunk) => {
				const { error } = await supabase
					.from("daily_asset_stats")
					.upsert(chunk, { onConflict: "symbol" });
				return { error };
			});
			if (upsertResult.failedChunks > 0) {
				// Still an error (alarms fire) but the successful chunks persisted.
				logger.error(
					"Some daily_asset_stats chunks failed to upsert",
					{
						action: "compute_daily_stats",
						upserted: upsertResult.upserted,
						failedChunks: upsertResult.failedChunks,
						failedRows: upsertResult.failedRows,
					},
					new Error("Partial upsert failure"),
				);
			}
		}

		logger.info("Daily stats computed", {
			action: "compute_daily_stats",
			total: symbols.length,
			computed,
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
			const failedSymbols = symbols.filter((symbol) => {
				return !rows.some((row) => row.symbol === symbol);
			});
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
