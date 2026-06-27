import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService, getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { fetchAssetPrices } from "../../../lib/market-data/prices";
import { getCurrentMarketSession } from "../../../lib/market-data/session";

/**
 * GET /api/price-targets
 *
 * Returns all active price targets for the authenticated user.
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
		logger.info("Price targets fetch without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	try {
		const { data, error } = await supabase
			.from("price_targets")
			.select("symbol, target_price, direction, created_at")
			.eq("user_id", user.id);

		if (error) {
			logger.error("Failed to fetch price targets", { userId: user.id }, error);
			return jsonResponse(500, {
				ok: false,
				message: "fetch_failed",
			});
		}

		// Fetch current prices for tracked assets; on provider failure still return saved targets
		const userAssets = await getUserAssets(supabase, user.id);
		const symbols = userAssets.map((a) => a.symbol);
		const prices: Record<string, number | null> = {};

		if (symbols.length > 0) {
			try {
				const session = await getCurrentMarketSession();
				const priceMap = await fetchAssetPrices(symbols, session);
				for (const symbol of symbols) {
					prices[symbol] = priceMap.get(symbol)?.price ?? null;
				}
			} catch (priceErr) {
				logger.error(
					"Price fetch failed for price-targets; returning targets without prices",
					{ userId: user.id, symbolCount: symbols.length },
					priceErr,
				);
			}
		}

		return Response.json({ ok: true, targets: data ?? [], prices });
	} catch (error) {
		logger.error("Failed to fetch price targets", { userId: user.id }, error);
		return jsonResponse(500, { ok: false, message: "fetch_failed" });
	}
};
