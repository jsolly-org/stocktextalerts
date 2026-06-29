/**
 * SEO route policy — single source of truth for sitemap vs robots behavior.
 *
 * Ahrefs audit remediation (2026-06): split sitemap exclusions from robots
 * disallows so noindex pages like /auth/pending-approval stay out of the sitemap
 * but remain crawlable for their HTML noindex directive. Admin and authenticated
 * surfaces are omitted from both sitemap and robots crawl.
 */

/** Routes that must never appear in sitemap output. */
export const SITEMAP_EXCLUDED_ROUTE_PREFIXES = [
	"/admin",
	"/auth/forgot",
	"/auth/pending-approval",
	"/auth/recover",
	"/auth/register",
	"/auth/signin",
	"/auth/unconfirmed",
	"/auth/verified",
	"/dashboard",
	"/email/unsubscribe",
	"/profile",
	"/404",
	"/500",
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
	"/email/unsubscribe",
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

/** True when a pathname should be filtered out of sitemap generation. */
export function isExcludedFromSitemap(pathname: string): boolean {
	const normalized = normalizePathname(pathname);
	return SITEMAP_EXCLUDED_ROUTE_PREFIXES.some((prefix) => matchesRoutePrefix(normalized, prefix));
}

/** True when a pathname should appear as Disallow in robots.txt. */
export function isDisallowedInRobots(pathname: string): boolean {
	const normalized = normalizePathname(pathname);
	return ROBOTS_DISALLOW_PREFIXES.some((prefix) => matchesRoutePrefix(normalized, prefix));
}
