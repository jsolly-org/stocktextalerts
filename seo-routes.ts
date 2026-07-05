/**
 * SEO route policy — single source of truth for robots behavior.
 *
 * The app is a private household tool (2026-07): a site-wide `X-Robots-Tag: noindex`
 * header (src/middleware.ts) keeps every response out of search indexes, and there is
 * no sitemap. Googlebot is still allowed to crawl so it ingests that noindex directive;
 * `ROBOTS_DISALLOW_PREFIXES` keeps admin/auth/app surfaces out of crawl entirely, and
 * `FULLY_BLOCKED_USER_AGENTS` shuts out SEO/AI scrapers (Ahrefs et al.) at the door.
 */

/**
 * User-agents denied the whole site in robots.txt. SEO index crawlers (Ahrefs, Semrush)
 * honor this and drop the site; AI scrapers are blocked as a courtesy signal (many ignore
 * it, but the noindex header is the real fence).
 */
export const FULLY_BLOCKED_USER_AGENTS = [
	"AhrefsBot",
	"SemrushBot",
	"MJ12bot",
	"DotBot",
	"GPTBot",
	"ClaudeBot",
	"CCBot",
	"Google-Extended",
	"PerplexityBot",
	"Bytespider",
	"Amazonbot",
] as const;

/** Routes that must not be crawled at all (robots.txt Disallow). */
export const ROBOTS_DISALLOW_PREFIXES = [
	"/admin",
	"/api/",
	"/auth/forgot",
	"/auth/recover",
	"/auth/register",
	"/auth/signin",
	"/auth/unconfirmed",
	"/auth/verified",
	"/dashboard",
	"/unsubscribe",
	"/profile",
] as const;

function normalizePathname(pathname: string): string {
	return pathname.replace(/\/$/, "") || "/";
}

function matchesRoutePrefix(pathname: string, prefix: string): boolean {
	if (pathname === prefix) {
		return true;
	}
	if (prefix.endsWith("/")) {
		return pathname.startsWith(prefix);
	}
	return pathname.startsWith(`${prefix}/`);
}

/** True when a pathname should appear as Disallow in robots.txt. */
export function isDisallowedInRobots(pathname: string): boolean {
	const normalized = normalizePathname(pathname);
	return ROBOTS_DISALLOW_PREFIXES.some((prefix) => matchesRoutePrefix(normalized, prefix));
}
