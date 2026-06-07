import type { APIRoute } from "astro";
import { getSiteUrl } from "../lib/db/env";
import { ROBOTS_DISALLOW_PREFIXES } from "../lib/seo/excluded-routes";

/** Ensure `robots.txt` is generated at build time. */
export const prerender = true;

/** Serve a `robots.txt` tailored to excluded routes + sitemap. */
export const GET: APIRoute = () => {
	const sitemapUrl = new URL("/sitemap-index.xml", getSiteUrl()).toString();
	const disallowLines = ROBOTS_DISALLOW_PREFIXES.map((prefix) => `Disallow: ${prefix}`).join("\n");

	const body = ["User-agent: *", "Allow: /", disallowLines, "", `Sitemap: ${sitemapUrl}`, ""].join(
		"\n",
	);

	return new Response(body, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
