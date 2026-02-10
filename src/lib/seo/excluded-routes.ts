/**
 * Single source of truth for route prefixes excluded from SEO crawling.
 *
 * Used by both the sitemap filter (astro.config.ts) and robots.txt generation
 * to keep the two in sync.
 */
export const EXCLUDED_ROUTE_PREFIXES = [
	"/auth/forgot",
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

/**
 * Additional prefixes disallowed in robots.txt but not relevant to the sitemap
 * (e.g. API routes that never appear in the sitemap).
 */
export const ROBOTS_ONLY_DISALLOW_PREFIXES = ["/api/"] as const;
