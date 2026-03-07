import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import {
	computeADV,
	computeATR,
} from "../../lib/market-notifications/daily-stats";
import { fetchDailyOHLCV } from "../../lib/providers/massive";
import { verifyCronSecret } from "../../lib/schedule/cron-auth";

/** Batch size for Massive API calls to stay under ~100 req/s. */
const BATCH_SIZE = 50;

/** Delay between batches (ms). */
const BATCH_DELAY_MS = 600;

/**
 * Daily cron endpoint to compute and upsert daily_asset_stats (ADV-20, ATR-14)
 * for all user-tracked symbols.
 *
 * Scheduled weekdays at 9 PM UTC (4-5 PM ET, after market close).
 */
const handler: APIRoute = async ({ url, request, locals }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	if (!verifyCronSecret(request, logger)) {
		return new Response("Unauthorized", { status: 401 });
	}

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
		return new Response(JSON.stringify({ error: "Failed to load assets" }), {
			status: 500,
		});
	}

	const symbols = [...new Set((allUserAssets ?? []).map((a) => a.symbol))];
	if (symbols.length === 0) {
		return new Response(JSON.stringify({ computed: 0 }), { status: 200 });
	}

	// Date range: 35 calendar days back to ensure ~20 trading days
	const to = new Date().toISOString().slice(0, 10);
	const from = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
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

	// Process in batches
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
			return new Response(
				JSON.stringify({ error: "Upsert failed", computed, failed }),
				{ status: 500 },
			);
		}
	}

	logger.info("Daily stats computed", {
		action: "compute_daily_stats",
		total: symbols.length,
		computed,
		failed,
	});

	return new Response(JSON.stringify({ computed, failed }), { status: 200 });
};

export const GET = handler;
export const POST = handler;
