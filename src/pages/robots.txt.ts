import type { APIRoute } from "astro";
import {
	EXCLUDED_ROUTE_PREFIXES,
	ROBOTS_ONLY_DISALLOW_PREFIXES,
} from "../lib/seo/excluded-routes";

export const prerender = true;

export const GET: APIRoute = () => {
	const disallowLines = [
		...ROBOTS_ONLY_DISALLOW_PREFIXES,
		...EXCLUDED_ROUTE_PREFIXES,
	]
		.map((prefix) => `Disallow: ${prefix}`)
		.join("\n");

	const body = [
		"User-agent: *",
		"Allow: /",
		disallowLines,
		"",
		"Sitemap: https://www.stocktextalerts.com/sitemap-index.xml",
		"",
	].join("\n");

	return new Response(body, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
