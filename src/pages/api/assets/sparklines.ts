import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../lib/client/types";
import { getUserAssets } from "../../../lib/db";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { fetchSparklines } from "../../../lib/market-data/sparklines";
import { isValidAssetSymbol } from "../../../lib/validation";

/** Max symbols per sparklines request — aligns with watchlist size cap. */
const MAX_SPARKLINE_SYMBOLS = 50;

/**
 * GET /api/assets/sparklines
 *
 * Returns 7-point sparkline close arrays for dashboard watchlist mini-charts
 * (`SparklineSvg`). Reads `asset_daily_closes` first (populated nightly by
 * compute-daily-stats), falling back to Massive only for cache misses (e.g.
 * a symbol the user just added). Non-critical: the client ignores fetch errors.
 *
 * Query params:
 * - `symbols` (optional): comma-separated tickers; when omitted, loads up to
 *   {@link MAX_SPARKLINE_SYMBOLS} tracked assets for the authenticated user.
 *   Invalid symbols are dropped.
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

	try {
		const symbolsParam = url.searchParams.get("symbols");
		let symbols: string[];

		if (symbolsParam) {
			// Incremental fetch after add-to-watchlist — only the new symbol(s).
			const raw = symbolsParam
				.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean);
			// Validate format and length; cap count to avoid abuse.
			symbols = [...new Set(raw.filter(isValidAssetSymbol))].slice(0, MAX_SPARKLINE_SYMBOLS);
		} else {
			// Initial dashboard load — one request for the full watchlist.
			const userAssets = await getUserAssets(supabase, user.id);
			symbols = userAssets.map((a) => a.symbol).slice(0, MAX_SPARKLINE_SYMBOLS);
		}

		if (symbols.length === 0) {
			return Response.json({ ok: true, sparklines: {} });
		}

		// asset_daily_closes is service_role-only — session client cannot read it.
		const sparklineMap = await fetchSparklines(symbols, {
			supabase: createSupabaseAdminClient(),
		});

		// Strip ascii/window — the Vue chart only needs numeric closes.
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
