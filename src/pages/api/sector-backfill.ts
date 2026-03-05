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

	try {
		const { data: rows, error } = await supabase
			.from("assets")
			.select("symbol, sector, icon_url")
			.or("sector.is.null,icon_url.is.null")
			.limit(BACKFILL_BATCH_SIZE);

		if (error) {
			logger.error(
				"Failed to query assets missing sector/icon_url",
				{ action: "sector_backfill" },
				error,
			);
			return new Response(
				JSON.stringify({ success: false, error: error.message }),
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}

		const items = rows ?? [];
		if (items.length === 0) {
			logger.info("No assets missing sector/icon_url — nothing to backfill", {
				action: "sector_backfill",
			});
			return new Response(
				JSON.stringify({ success: true, updated: 0, skipped: 0 }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		let updated = 0;
		let skipped = 0;

		for (const row of items) {
			const { symbol } = row;
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
				const branding = (results as Record<string, unknown>).branding;
				const iconUrl =
					typeof branding === "object" && branding !== null
						? (branding as Record<string, unknown>).icon_url
						: undefined;

				const updatePayload: Record<string, unknown> = {};
				const needsSector = row.sector == null;
				if (
					needsSector &&
					(typeof sicCode === "string" || typeof sicCode === "number")
				) {
					updatePayload.sector = sicCodeToSector(String(sicCode));
				}
				// Reject blank icon_url so the row stays eligible for backfill and UI doesn't stick on fallback
				if (
					row.icon_url == null &&
					typeof iconUrl === "string" &&
					iconUrl.trim() !== ""
				) {
					updatePayload.icon_url = iconUrl;
				}
				if (Object.keys(updatePayload).length === 0) {
					skipped++;
					continue;
				}
				const { error: updateError } = await supabase
					.from("assets")
					.update(updatePayload)
					.eq("symbol", symbol);
				if (updateError) {
					logger.warn(
						"Supabase update failed for sector backfill",
						{ symbol, ...updatePayload },
						updateError,
					);
					skipped++;
					continue;
				}
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
			total: items.length,
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
