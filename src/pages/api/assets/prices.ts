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
 * Returns prevClose, sector, and iconUrl for the user's tracked assets.
 * Used by the onboarding wizard to show asset-grounded examples.
 * Lazy-backfills sector and icon_url from Massive for assets missing them (writes via admin client;
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
		const { data: assetRows, error: assetRowsError } = await supabase
			.from("assets")
			.select("symbol, sector, icon_url")
			.in("symbol", symbols);
		if (assetRowsError) {
			logger.error(
				"Failed to load asset sectors",
				{ userId: user.id },
				assetRowsError,
			);
			return jsonResponse(500, { ok: false, message: "fetch_failed" });
		}

		const sectorMap = new Map<string, string | null>();
		const iconUrlMap = new Map<string, string | null>();
		for (const row of assetRows) {
			const r = row as {
				symbol: string;
				sector: string | null;
				icon_url: string | null;
			};
			sectorMap.set(r.symbol, r.sector);
			iconUrlMap.set(r.symbol, r.icon_url);
		}

		// Lazy backfill: fetch sector + icon_url from Massive for assets missing either.
		// Include null icon_url rows so existing assets can get icons when available.
		// Use admin client for updates — authenticated has SELECT only on assets.
		// Process sequentially to avoid unbounded fan-out of Massive API calls.
		const missingSectorSymbols = symbols.filter(
			(s) => sectorMap.get(s) == null || iconUrlMap.get(s) == null,
		);
		if (missingSectorSymbols.length > 0) {
			const adminSupabase = createSupabaseAdminClient();
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
					const branding = (results as Record<string, unknown>).branding;
					const iconUrl =
						typeof branding === "object" && branding !== null
							? (branding as Record<string, unknown>).icon_url
							: undefined;

					const updatePayload: Record<string, unknown> = {};
					if (
						sectorMap.get(symbol) == null &&
						(typeof sicCode === "string" || typeof sicCode === "number")
					) {
						const sector = sicCodeToSector(String(sicCode));
						sectorMap.set(symbol, sector);
						updatePayload.sector = sector;
					}
					if (
						iconUrlMap.get(symbol) == null &&
						typeof iconUrl === "string" &&
						iconUrl.length > 0
					) {
						iconUrlMap.set(symbol, iconUrl);
						updatePayload.icon_url = iconUrl;
					}
					if (Object.keys(updatePayload).length === 0) continue;

					const { error: updateError } = await adminSupabase
						.from("assets")
						.update(updatePayload)
						.eq("symbol", symbol);
					if (updateError) {
						logger.warn(
							"Supabase asset metadata (sector/icon) update failed",
							{ symbol, ...updatePayload },
							updateError,
						);
					}
				} catch (err) {
					logger.warn(
						"Failed to fetch asset metadata (sector/icon) for asset",
						{ symbol },
						err,
					);
				}
			}
		}

		const assets: Record<
			string,
			{
				prevClose: number | null;
				sector: string | null;
				iconUrl: string | null;
			}
		> = {};
		for (const symbol of symbols) {
			const quote = quoteMap.get(symbol);
			assets[symbol] = {
				prevClose: quote?.prevClose ?? null,
				sector: sectorMap.get(symbol) ?? null,
				iconUrl: iconUrlMap.get(symbol) ?? null,
			};
		}

		return Response.json({ ok: true, assets });
	} catch (error) {
		logger.error("Failed to fetch asset prices", { userId: user.id }, error);
		return jsonResponse(500, { ok: false, message: "fetch_failed" });
	}
};
