import type { APIRoute } from "astro";
import { createUserService } from "../../../../lib/db";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { createLogger } from "../../../../lib/logging";

/**
 * GET /api/assets/logo/:symbol
 *
 * Proxies the Massive branding icon image for a given asset symbol.
 * The API key is appended server-side so it never reaches the browser.
 * Returns the upstream image bytes with a 7-day browser cache.
 */
export const GET: APIRoute = async ({ params, request, cookies, locals }) => {
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
		return new Response("Unauthorized", { status: 401 });
	}

	const rawSymbol = params.symbol;
	if (!rawSymbol) {
		return new Response("Bad request", { status: 400 });
	}
	let symbol: string;
	try {
		symbol = decodeURIComponent(rawSymbol).toUpperCase();
	} catch {
		return new Response("Bad request", { status: 400 });
	}
	// Match DB constraint (assets.symbol VARCHAR(10)); reject oversized to avoid abuse
	if (symbol.length > 10) {
		return new Response("Bad request", { status: 400 });
	}

	const { data, error } = await supabase
		.from("assets")
		.select("icon_url")
		.eq("symbol", symbol)
		.maybeSingle();

	if (error) {
		logger.error("Failed to look up icon_url", { symbol }, error);
		return new Response("Internal server error", { status: 500 });
	}

	const iconUrl = data?.icon_url;
	if (!iconUrl) {
		return new Response("Not found", { status: 404 });
	}

	const rawApiKey =
		(import.meta.env.MASSIVE_API_KEY as string | undefined) ??
		process.env.MASSIVE_API_KEY;
	if (typeof rawApiKey !== "string" || rawApiKey.trim() === "") {
		logger.error("MASSIVE_API_KEY not configured", { symbol });
		return new Response("Internal server error", { status: 500 });
	}
	const apiKey = rawApiKey.trim();

	let upstreamUrl: string;
	try {
		const parsed = new URL(iconUrl);
		const allowedHosts = new Set(["api.massive.com"]);
		if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
			logger.warn("Rejected icon_url host for logo proxy", {
				symbol,
				host: parsed.hostname,
			});
			return new Response("Not found", { status: 404 });
		}
		parsed.searchParams.set("apiKey", apiKey);
		upstreamUrl = parsed.toString();
	} catch (error) {
		logger.warn("Invalid icon_url for logo proxy", { symbol }, error);
		return new Response("Not found", { status: 404 });
	}

	try {
		const upstream = await fetch(upstreamUrl, {
			signal: AbortSignal.timeout(10_000),
		});

		if (!upstream.ok) {
			logger.warn("Upstream icon fetch failed", {
				symbol,
				status: upstream.status,
			});
			return new Response("Not found", { status: 404 });
		}

		const contentType = upstream.headers.get("Content-Type") ?? "image/png";
		const body = await upstream.arrayBuffer();

		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": contentType,
				"Cache-Control":
					"public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400",
			},
		});
	} catch (err) {
		logger.error("Failed to fetch upstream icon", { symbol }, err);
		return new Response("Internal server error", { status: 500 });
	}
};
