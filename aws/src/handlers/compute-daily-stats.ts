import type { Context, ScheduledEvent } from "aws-lambda";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase";
import { createLogger } from "../../../src/lib/logging";
import {
	computeADV,
	computeATR,
} from "../../../src/lib/market-notifications/daily-stats";
import { fetchDailyOHLCV } from "../../../src/lib/providers/massive";

/** Batch size for Massive API calls to stay under ~100 req/s. */
const BATCH_SIZE = 50;

/** Delay between batches (ms). */
const BATCH_DELAY_MS = 600;

/** Calendar days to fetch for ~20 trading days of data. */
const LOOKBACK_DAYS = 35;

export async function handler(_event: ScheduledEvent, context: Context): Promise<void> {
	const logger = createLogger({
		baseContext: { source: "lambda", function: "compute-daily-stats" },
		lambdaContext: context,
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

	const symbols = [...new Set((allUserAssets ?? []).map((a) => a.symbol))];
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
		}

		// Delay between batches to avoid rate limits
		if (i + BATCH_SIZE < symbols.length) {
			await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
		}
	}

	// Upsert all rows
	if (rows.length > 0) {
		const { error: upsertError } = await supabase
			.from("daily_asset_stats")
			.upsert(rows, { onConflict: "symbol" });

		if (upsertError) {
			logger.error(
				"Failed to upsert daily_asset_stats",
				{ rowCount: rows.length },
				upsertError,
			);
			throw new Error("Upsert failed");
		}
	}

	logger.info("Daily stats computed", {
		action: "compute_daily_stats",
		total: symbols.length,
		computed,
		failed,
	});
}
