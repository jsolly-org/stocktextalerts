import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import { marketDataFetch } from "../../lib/providers/massive";
import { sicCodeToSector } from "../../lib/providers/sector-mapping";
import { verifyCronSecret } from "../../lib/schedule/cron-auth";

const BACKFILL_BATCH_SIZE = 20;

/**
 * Daily cron endpoint to backfill missing `sector` values on the `assets` table.
 *
 * For each asset missing a sector, fetches the SIC code from Massive's ticker
 * details endpoint and maps it to a sector name. Runs daily at 06:00 UTC so
 * sectors are populated before market open.
 */
const handler: APIRoute = async ({ request, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	if (!verifyCronSecret(request, logger)) {
		return new Response("Unauthorized", { status: 401 });
	}

	const supabase = createSupabaseAdminClient();

	try {
		const { data: rows, error } = await supabase
			.from("assets")
			.select("symbol")
			.is("sector", null)
			.limit(BACKFILL_BATCH_SIZE);

		if (error) {
			logger.error(
				"Failed to query assets missing sector",
				{ action: "sector_backfill" },
				error,
			);
			return new Response(
				JSON.stringify({ success: false, error: error.message }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}

		const symbols = (rows ?? []).map((r) => r.symbol);
		if (symbols.length === 0) {
			logger.info("No assets missing sector — nothing to backfill", {
				action: "sector_backfill",
			});
			return new Response(
				JSON.stringify({ success: true, updated: 0, skipped: 0 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		let updated = 0;
		let skipped = 0;

		for (const symbol of symbols) {
			try {
				const data = await marketDataFetch(
					`/v3/reference/tickers/${encodeURIComponent(symbol)}`,
					{},
					"ticker-details",
				);
				if (typeof data !== "object" || data === null) {
					skipped++;
					continue;
				}
				const results = (data as Record<string, unknown>).results;
				if (typeof results !== "object" || results === null) {
					skipped++;
					continue;
				}
				const sicCode = (results as Record<string, unknown>).sic_code;
				if (typeof sicCode !== "string" && typeof sicCode !== "number") {
					skipped++;
					continue;
				}
				const sector = sicCodeToSector(String(sicCode));
				await supabase
					.from("assets")
					.update({ sector } as Record<string, unknown>)
					.eq("symbol", symbol);
				updated++;
			} catch (err) {
				logger.warn(
					"Failed to fetch sector for asset during backfill",
					{ symbol },
					err,
				);
				skipped++;
			}
		}

		logger.info("Sector backfill complete", {
			action: "sector_backfill",
			total: symbols.length,
			updated,
			skipped,
		});

		return new Response(JSON.stringify({ success: true, updated, skipped }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		logger.error(
			"Sector backfill cron error",
			{ action: "sector_backfill" },
			error,
		);
		return new Response("Internal server error", { status: 500 });
	}
};

export const GET: APIRoute = handler;
