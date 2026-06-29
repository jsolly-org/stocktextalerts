import type { APIRoute } from "astro";
import type { ApiJsonBody } from "../../../lib/client/json-response";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const SEARCH_CANDIDATE_MULTIPLIER = 5;

/** Assigns a rank for search result ordering (0 = exact symbol match, 4 = no match). */
function getAssetSearchRank(
	row: { symbol: string; name: string },
	normalizedQuery: string,
): number {
	const symbol = row.symbol.toUpperCase();
	const name = row.name.toUpperCase();

	if (symbol === normalizedQuery) {
		return 0;
	}

	if (symbol.startsWith(normalizedQuery)) {
		return 1;
	}

	if (name.startsWith(normalizedQuery)) {
		return 2;
	}

	if (name.includes(normalizedQuery)) {
		return 3;
	}

	return 4;
}

/**
 * Search assets by symbol or name prefix/substring.
 *
 * Requires authentication. Query length is limited to prevent abuse.
 * Returns results sorted by relevance (exact symbol > symbol prefix > name prefix > name contains).
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
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	const query = url.searchParams.get("q")?.trim() ?? "";
	/** Limit query length to reduce ILIKE load and prevent abuse. */
	const MAX_QUERY_LENGTH = 100;
	if (query.length < 1) {
		return Response.json({ ok: true, message: "ok", results: [] } satisfies ApiJsonBody, {
			status: 200,
		});
	}
	if (query.length > MAX_QUERY_LENGTH) {
		return Response.json({ ok: false, message: "query_too_long" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const limit = Number.isFinite(limitParam)
		? Math.min(Math.max(1, limitParam), MAX_LIMIT)
		: DEFAULT_LIMIT;

	// PostgREST `.or()` takes a raw filter string; values containing reserved
	// characters (e.g. `,()`) must be quoted. Also escape `%`/`_` so user input
	// is treated literally in ILIKE patterns (we add our own wildcards).
	const escapeLikeLiteral = (input: string) =>
		input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
	const quotePostgrestValue = (value: string) => {
		const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${escaped}"`;
	};

	const likeQuery = escapeLikeLiteral(query);
	const normalizedQuery = query.toUpperCase();
	const symbolPrefixPattern = `${likeQuery}%`;
	const nameContainsPattern = `%${likeQuery}%`;
	const quotedSymbolPrefixPattern = quotePostgrestValue(symbolPrefixPattern);
	const quotedNameContainsPattern = quotePostgrestValue(nameContainsPattern);
	const candidateLimit = Math.min(limit * SEARCH_CANDIDATE_MULTIPLIER, 100);

	try {
		// Use ilike for prefix matching on symbol, or textSearch for name
		// Symbol prefix match (exact start) OR name substring match
		const { data, error } = await supabase
			.from("assets")
			.select("symbol, name, type, icon_url")
			.or(`symbol.ilike.${quotedSymbolPrefixPattern},name.ilike.${quotedNameContainsPattern}`)
			.order("symbol")
			.limit(candidateLimit);

		if (error) {
			logger.error("Asset search query failed", { userId: user.id, query }, error);
			return Response.json(
				{
					ok: false,
					message: "search_failed",
				} satisfies ApiJsonBody,
				{ status: 500 },
			);
		}

		const candidates = data ?? [];
		const rankCache = new Map<string, number>();
		for (const row of candidates) {
			rankCache.set(row.symbol, getAssetSearchRank(row, normalizedQuery));
		}
		const results = candidates
			.sort((left, right) => {
				const rankDifference =
					(rankCache.get(left.symbol) ?? 4) - (rankCache.get(right.symbol) ?? 4);
				if (rankDifference !== 0) {
					return rankDifference;
				}
				return left.symbol.localeCompare(right.symbol);
			})
			.slice(0, limit)
			.map((row) => ({
				symbol: row.symbol,
				name: row.name,
				type: row.type,
				icon_url: row.icon_url,
			}));

		return Response.json({ ok: true, message: "ok", results } satisfies ApiJsonBody, {
			status: 200,
		});
	} catch (error) {
		logger.error("Unexpected error in asset search", { userId: user.id, query }, error);
		return Response.json({ ok: false, message: "search_failed" } satisfies ApiJsonBody, {
			status: 500,
		});
	}
};
