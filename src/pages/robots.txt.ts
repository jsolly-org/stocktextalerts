import type { APIRoute } from "astro";
import { FULLY_BLOCKED_USER_AGENTS, ROBOTS_DISALLOW_PREFIXES } from "../../seo-routes";

/** Ensure `robots.txt` is generated at build time. */
export const prerender = true;

/**
 * Serve a `robots.txt` for the private household app.
 *
 * General crawlers may still fetch pages (so they process the site-wide
 * `X-Robots-Tag: noindex` header) but are kept out of app/auth surfaces. SEO/AI
 * scrapers are denied the whole site. There is no sitemap.
 */
export const GET: APIRoute = () => {
	const generalDisallow = ROBOTS_DISALLOW_PREFIXES.map((prefix) => `Disallow: ${prefix}`).join(
		"\n",
	);

	const blockedBlocks = FULLY_BLOCKED_USER_AGENTS.map(
		(agent) => `User-agent: ${agent}\nDisallow: /`,
	).join("\n\n");

	const body = ["User-agent: *", "Allow: /", generalDisallow, "", blockedBlocks, ""].join("\n");

	return new Response(body, {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
