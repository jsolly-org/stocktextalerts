import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { jsonResponse } from "../../../lib/json-response";
import { createLogger } from "../../../lib/logging";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

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
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	const query = url.searchParams.get("q")?.trim() ?? "";
	if (query.length < 1) {
		return jsonResponse(200, { ok: true, message: "ok", results: [] });
	}

	const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isFinite(limitParam)
		? Math.min(Math.max(1, limitParam), MAX_LIMIT)
		: DEFAULT_LIMIT;

	try {
		// Use ilike for prefix matching on symbol, or textSearch for name
		// Symbol prefix match (exact start) OR name substring match
		const searchPattern = `%${query}%`;
		const { data, error } = await supabase
			.from("assets")
			.select("symbol, name, type")
			.or(`symbol.ilike.${query}%,name.ilike.${searchPattern}`)
			.order("symbol")
			.limit(limit);

		if (error) {
			logger.error("Asset search query failed", {
				userId: user.id,
				query,
				error: error.message,
			});
			return jsonResponse(500, {
				ok: false,
				message: "search_failed",
			});
		}

		const results = (data ?? []).map((row) => ({
			symbol: row.symbol,
			name: row.name,
			type: row.type,
		}));

		return jsonResponse(200, { ok: true, message: "ok", results });
	} catch (error) {
		logger.error(
			"Unexpected error in asset search",
			{ userId: user.id, query },
			error,
		);
		return jsonResponse(500, { ok: false, message: "search_failed" });
	}
};
