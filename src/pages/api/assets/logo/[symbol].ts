import type { APIRoute } from "astro";
import {
	ALLOWED_LOGO_MIME_TYPES,
	MAX_LOGO_BYTES,
} from "../../../../lib/assets/reference/constants";
import { resolveLogoUpstreamUrl } from "../../../../lib/assets/reference/ticker-detail";
import { createUserService } from "../../../../lib/auth/user-service";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { createLogger } from "../../../../lib/logging";
import { isValidAssetSymbol } from "../../../../lib/validation";

/**
 * GET /api/assets/logo/:symbol
 *
 * Authenticated logo proxy for dashboard `AssetBadge` images. Looks up
 * `assets.icon_url` and streams the upstream bytes back to the browser.
 * `resolveLogoUpstreamUrl` restricts the host to the allowed logo CDNs (SSRF
 * guard on the DB-sourced URL) and appends `MASSIVE_API_KEY` server-side for
 * Massive-era URLs so the key never reaches the client; Finnhub CDN URLs are
 * public. CDN caching via Astro 7 `context.cache.set()` (Vercel `cacheVercel()`
 * in production).
 */
export const GET: APIRoute = async ({ url, params, request, cookies, locals, cache }) => {
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
		symbol = decodeURIComponent(rawSymbol).trim().toUpperCase();
	} catch {
		return new Response("Bad request", { status: 400 });
	}
	if (!isValidAssetSymbol(symbol)) {
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

	const upstreamUrl = resolveLogoUpstreamUrl(iconUrl);
	if (upstreamUrl === null) {
		logger.info("Rejected icon_url for logo proxy", { symbol });
		return new Response("Not found", { status: 404 });
	}

	try {
		const upstream = await fetch(upstreamUrl, {
			signal: AbortSignal.timeout(10_000),
		});

		if (!upstream.ok) {
			logger.error("Upstream icon fetch failed", {
				symbol,
				status: upstream.status,
			});
			return new Response("Not found", { status: 404 });
		}

		// This response is navigable on the app origin and CDN-cached for a week, so
		// only raster image types pass — an SVG or mislabeled HTML body would execute
		// with the viewer's session and get pinned in the shared cache.
		const rawContentType = upstream.headers.get("Content-Type") ?? "image/png";
		const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() || "image/png";
		if (!ALLOWED_LOGO_MIME_TYPES.has(contentType)) {
			logger.info("Rejected upstream icon content type", { symbol, contentType });
			return new Response("Not found", { status: 404 });
		}

		const body = await upstream.arrayBuffer();
		if (body.byteLength > MAX_LOGO_BYTES) {
			logger.info("Rejected oversized upstream icon", { symbol, byteLength: body.byteLength });
			return new Response("Not found", { status: 404 });
		}

		// Logos change rarely; cache 7d with 1d SWR for CDN efficiency.
		if (cache.enabled) {
			cache.set({
				maxAge: 604_800,
				swr: 86_400,
				tags: [`assets:logo:${symbol}`],
			});
		}

		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": contentType,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (err) {
		logger.error("Failed to fetch upstream icon", { symbol }, err);
		return new Response("Internal server error", { status: 500 });
	}
};
