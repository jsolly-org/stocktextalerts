import type { APIRoute } from "astro";
import { createUserService } from "../../../../lib/db";
import { requireEnv } from "../../../../lib/db/env";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { createLogger } from "../../../../lib/logging";
import { isValidAssetSymbol } from "../../../../lib/validation";

/**
 * GET /api/assets/logo/:symbol
 *
 * Authenticated logo proxy for dashboard `AssetBadge` images. Looks up
 * `assets.icon_url` (a Massive branding URL stored without the API key),
 * appends `MASSIVE_API_KEY` server-side, and streams the upstream bytes back
 * to the browser so the key never reaches the client. Host is restricted to
 * `api.massive.com` to block SSRF via poisoned icon_url values. CDN caching
 * via Astro 7 `context.cache.set()` (Vercel `cacheVercel()` in production).
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

	const apiKey = requireEnv("MASSIVE_API_KEY");

	let upstreamUrl: string;
	try {
		const parsed = new URL(iconUrl);
		// icon_url is DB-sourced; allowlist prevents fetching arbitrary hosts.
		const allowedHosts = new Set(["api.massive.com"]);
		if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
			logger.info("Rejected icon_url host for logo proxy", {
				symbol,
				host: parsed.hostname,
			});
			return new Response("Not found", { status: 404 });
		}
		parsed.searchParams.set("apiKey", apiKey);
		upstreamUrl = parsed.toString();
	} catch (error) {
		logger.info("Invalid icon_url for logo proxy", { symbol }, error);
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

		const contentType = upstream.headers.get("Content-Type") ?? "image/png";
		const body = await upstream.arrayBuffer();

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
			},
		});
	} catch (err) {
		logger.error("Failed to fetch upstream icon", { symbol }, err);
		return new Response("Internal server error", { status: 500 });
	}
};
