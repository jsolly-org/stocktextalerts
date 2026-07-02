import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../lib/client/types";
import { getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { fetchExtendedQuotes } from "../../../lib/market-data/prices";
import { getCurrentMarketSession } from "../../../lib/market-data/session";

/**
 * GET /api/assets/prices
 *
 * Live quote metadata for the authenticated user's watchlist. Fetches prevClose
 * from Massive via `fetchExtendedQuotes` (session-aware — pre/post-market
 * behavior matches notification pricing) and merges static sector/icon_url from
 * the assets table. Consumed by the move-size selector to show dollar/percent
 * examples grounded in each tracked symbol's prev close.
 */
export const GET: APIRoute = async ({ url, request, cookies, locals }) => {
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
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	try {
		const userAssets = await getUserAssets(supabase, user.id);
		const symbols = userAssets.map((a) => a.symbol);

		if (symbols.length === 0) {
			return Response.json({ ok: true, assets: {} });
		}

		// Session drives which Massive snapshot fields are populated (e.g. prevDay.c).
		const session = await getCurrentMarketSession();
		const quoteMap = await fetchExtendedQuotes(symbols, session);

		// Sector and icon_url are reference data — not on the Massive snapshot.
		const { data: assetRows, error: assetRowsError } = await supabase
			.from("assets")
			.select("symbol, sector, icon_url")
			.in("symbol", symbols);
		if (assetRowsError) {
			logger.error("Failed to load asset sectors", { userId: user.id }, assetRowsError);
			return Response.json({ ok: false, message: "fetch_failed" } satisfies ApiJsonBody, {
				status: 500,
			});
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
		return Response.json({ ok: false, message: "fetch_failed" } satisfies ApiJsonBody, {
			status: 500,
		});
	}
};
