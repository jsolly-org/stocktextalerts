import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService, getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { fetchSparklines } from "../../../lib/providers/price-fetcher";

/**
 * GET /api/assets/sparklines
 *
 * Returns 7-point sparkline close data for the user's tracked assets.
 * Accepts an optional `symbols` query param (comma-separated) to fetch
 * sparklines for specific symbols instead of all user assets.
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
		logger.info("Sparklines request without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	try {
		const symbolsParam = url.searchParams.get("symbols");
		let symbols: string[];

		if (symbolsParam) {
			symbols = symbolsParam
				.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean);
		} else {
			const userAssets = await getUserAssets(supabase, user.id);
			symbols = userAssets.map((a) => a.symbol);
		}

		if (symbols.length === 0) {
			return Response.json({ ok: true, sparklines: {} });
		}

		const sparklineMap = await fetchSparklines(symbols);

		const sparklines: Record<string, number[] | null> = {};
		for (const symbol of symbols) {
			const data = sparklineMap.get(symbol);
			sparklines[symbol] = data?.values ?? null;
		}

		return Response.json({ ok: true, sparklines });
	} catch (error) {
		logger.error("Failed to fetch sparklines", { userId: user.id }, error);
		return jsonResponse(500, { ok: false, message: "fetch_failed" });
	}
};
