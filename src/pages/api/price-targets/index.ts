import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService, getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { fetchAssetPrices } from "../../../lib/providers/price-fetcher";

/**
 * GET /api/price-targets
 *
 * Returns all active price targets for the authenticated user.
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

		// Also fetch current prices for tracked assets
		const userAssets = await getUserAssets(supabase, user.id);
		const symbols = userAssets.map((a) => a.symbol);
		const prices: Record<string, number | null> = {};

		if (symbols.length > 0) {
			const priceMap = await fetchAssetPrices(symbols);
			for (const symbol of symbols) {
				prices[symbol] = priceMap.get(symbol)?.price ?? null;
			}
		}

		return Response.json({ ok: true, targets: data ?? [], prices });
	} catch (error) {
		logger.error("Failed to fetch price targets", { userId: user.id }, error);
		return jsonResponse(500, { ok: false, message: "fetch_failed" });
	}
};
