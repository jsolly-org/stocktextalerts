import type { APIRoute } from "astro";
import type { ApiJsonBody } from "../../../lib/client/json-response";
import { createUserService, getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { fetchSparklines } from "../../../lib/market-data/sparklines";
import { isValidAssetSymbol } from "../../../lib/validation";

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
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	const MAX_SPARKLINE_SYMBOLS = 50;

	try {
		const symbolsParam = url.searchParams.get("symbols");
		let symbols: string[];

		if (symbolsParam) {
			const raw = symbolsParam
				.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean);
			// Validate format and length; cap count to avoid abuse.
			symbols = [...new Set(raw.filter(isValidAssetSymbol))].slice(0, MAX_SPARKLINE_SYMBOLS);
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
		return Response.json({ ok: false, message: "fetch_failed" } satisfies ApiJsonBody, {
			status: 500,
		});
	}
};
