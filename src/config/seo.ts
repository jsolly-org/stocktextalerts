/**
 * Single source-of-truth for SEO exclusions.
 *
 * Routes in this list are:
 * - Excluded from the sitemap (via sitemapFilter in astro.config.ts)
 * - Disallowed in robots.txt
 *
 * This ensures consistency between sitemap generation and crawler directives.
 */
export const seoExcludedRoutes = [
	// Authentication flow pages (no SEO value, user-specific)
	"/auth/forgot",
	"/auth/recover",
	"/auth/register",
	"/auth/signin",
	"/auth/unconfirmed",
	"/auth/verified",
	// Authenticated user pages (user-specific, no SEO value)
	"/dashboard",
	"/profile",
	// Utility pages (user-specific actions)
	"/email/unsubscribe",
	// Error pages (no SEO value)
	"/404",
	"/500",
] as const;

/**
 * Routes that should be disallowed in robots.txt but may not need
 * to be excluded from the sitemap (e.g., API endpoints that aren't
 * rendered as pages anyway).
 */
export const robotsOnlyDisallowedRoutes = [
	"/api/", // API endpoints should not be crawled
] as const;

/**
 * Get all routes that should be disallowed in robots.txt.
 * This is the union of sitemap exclusions and robots-only exclusions.
 */
export function getAllRobotsDisallowedRoutes(): readonly string[] {
	return [...seoExcludedRoutes, ...robotsOnlyDisallowedRoutes];
}
