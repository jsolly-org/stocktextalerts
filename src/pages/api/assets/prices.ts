import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService, getUserAssets } from "../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { marketDataFetch } from "../../../lib/providers/massive";
import { fetchExtendedQuotes } from "../../../lib/providers/price-fetcher";
import { sicCodeToSector } from "../../../lib/providers/sector-mapping";

/**
 * GET /api/assets/prices
 *
 * Returns prevClose and sector for the user's tracked assets.
 * Used by the onboarding wizard to show asset-grounded examples.
 * Lazy-backfills sector from Massive for assets missing it (writes via admin client;
 * authenticated user has SELECT-only on assets).
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
		// Use admin client for updates — authenticated has SELECT only on assets.
		const missingSectorSymbols = symbols.filter((s) => !sectorMap.get(s));
		if (missingSectorSymbols.length > 0) {
			const adminSupabase = createSupabaseAdminClient();
			await Promise.all(
				missingSectorSymbols.map(async (symbol) => {
					try {
						const data = await marketDataFetch(
							`/v3/reference/tickers/${encodeURIComponent(symbol)}`,
							{},
							"ticker-details",
						);
						if (typeof data !== "object" || data === null) return;
						const results = (data as Record<string, unknown>).results;
						if (typeof results !== "object" || results === null) return;
						const sicCode = (results as Record<string, unknown>).sic_code;
						if (typeof sicCode !== "string" && typeof sicCode !== "number")
							return;
						const sector = sicCodeToSector(String(sicCode));
						sectorMap.set(symbol, sector);

						await adminSupabase
							.from("assets")
							.update({ sector } as Record<string, unknown>)
							.eq("symbol", symbol);
					} catch (err) {
						logger.warn("Failed to fetch sector for asset", { symbol }, err);
					}
				}),
			);
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
