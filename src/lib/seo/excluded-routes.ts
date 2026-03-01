/* Single source of truth for route prefixes excluded from SEO (sitemap + robots.txt). */
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

/* Disallowed in robots.txt only (e.g. /api/); not relevant to sitemap. */
export const ROBOTS_ONLY_DISALLOW_PREFIXES = ["/api/"] as const;
