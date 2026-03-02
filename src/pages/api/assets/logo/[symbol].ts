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

	const symbol = params.symbol;
	if (!symbol) {
		return new Response("Bad request", { status: 400 });
	}

	const { data, error } = await supabase
		.from("assets")
		.select("icon_url")
		.eq("symbol", symbol.toUpperCase())
		.maybeSingle();

	if (error) {
		logger.error("Failed to look up icon_url", { symbol }, error);
		return new Response("Internal server error", { status: 500 });
	}

	const iconUrl = data?.icon_url;
	if (!iconUrl) {
		return new Response("Not found", { status: 404 });
	}

	const apiKey =
		(import.meta.env.MASSIVE_API_KEY as string | undefined) ??
		process.env.MASSIVE_API_KEY ??
		"";
	if (!apiKey) {
		logger.error("MASSIVE_API_KEY not configured", { symbol });
		return new Response("Internal server error", { status: 500 });
	}

	const separator = iconUrl.includes("?") ? "&" : "?";
	const upstreamUrl = `${iconUrl}${separator}apiKey=${apiKey}`;

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
				"Cache-Control": "public, max-age=604800",
			},
		});
	} catch (err) {
		logger.error("Failed to fetch upstream icon", { symbol }, err);
		return new Response("Internal server error", { status: 500 });
	}
};
