import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService, getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { marketDataFetch } from "../../../lib/providers/massive";
import { fetchExtendedQuotes } from "../../../lib/providers/price-fetcher";
import { sicCodeToSector } from "../../../lib/providers/sector-mapping";

/**
 * GET /api/assets/prices
 *
 * Returns prevClose and sector for the user's tracked assets.
 * Used by the onboarding wizard to show asset-grounded examples.
 */
export const GET: APIRoute = async ({ request, cookies, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const userService = createUserService(supabase, cookies);

	const user = await userService.getCurrentUser();
	if (!user) {
		logger.info("Asset prices request without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	try {
		const userAssets = await getUserAssets(supabase, user.id);
		const symbols = userAssets.map((a) => a.symbol);

		if (symbols.length === 0) {
			return Response.json({ ok: true, assets: {} });
		}

		const quoteMap = await fetchExtendedQuotes(symbols);

		// Load existing sector values from assets table
		const { data: assetRows } = await supabase
			.from("assets")
			.select("symbol, sector")
			.in("symbol", symbols);

		const sectorMap = new Map<string, string | null>();
		for (const row of assetRows ?? []) {
			sectorMap.set(
				row.symbol,
				(row as { symbol: string; sector: string | null }).sector,
			);
		}

		// Lazy backfill: fetch sector from Massive for assets missing it.
		// Process sequentially to avoid unbounded fan-out of Massive API calls.
		const missingSectorSymbols = symbols.filter((s) => !sectorMap.get(s));
		for (const symbol of missingSectorSymbols) {
			try {
				const data = await marketDataFetch(
					`/v3/reference/tickers/${encodeURIComponent(symbol)}`,
					{},
					"ticker-details",
				);
				if (typeof data !== "object" || data === null) continue;
				const results = (data as Record<string, unknown>).results;
				if (typeof results !== "object" || results === null) continue;
				const sicCode = (results as Record<string, unknown>).sic_code;
				if (typeof sicCode !== "string" && typeof sicCode !== "number")
					continue;
				const sector = sicCodeToSector(String(sicCode));
				sectorMap.set(symbol, sector);

				const { error: updateError } = await supabase
					.from("assets")
					.update({ sector } as Record<string, unknown>)
					.eq("symbol", symbol);
				if (updateError) {
					logger.warn(
						"Supabase sector update failed",
						{ symbol, sector },
						updateError,
					);
				}
			} catch (err) {
				logger.warn("Failed to fetch sector for asset", { symbol }, err);
			}
		}

		const assets: Record<
			string,
			{ prevClose: number | null; sector: string | null }
		> = {};
		for (const symbol of symbols) {
			const quote = quoteMap.get(symbol);
			assets[symbol] = {
				prevClose: quote?.prevClose ?? null,
				sector: sectorMap.get(symbol) ?? null,
			};
		}

		return Response.json({ ok: true, assets });
	} catch (error) {
		logger.error("Failed to fetch asset prices", { userId: user.id }, error);
		return jsonResponse(500, { ok: false, message: "fetch_failed" });
	}
};
