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

/**
 * Site URL used in robots.txt sitemap reference.
 * This is hardcoded here as it's only used for robots.txt generation.
 * The actual site URL for the application is configured in astro.config.ts.
 */
export const ROBOTS_TXT_SITE_URL = "https://www.stocktextalerts.com";

/**
 * Generate the complete robots.txt content from the SEO configuration.
 * This is the single source-of-truth for robots.txt structure.
 */
export function generateRobotsTxtContent(): string {
	const disallowedRoutes = getAllRobotsDisallowedRoutes();

	const lines = [
		"User-agent: *",
		"Allow: /",
		// Add each disallowed route
		...disallowedRoutes.map((route) => `Disallow: ${route}`),
		"",
		`Sitemap: ${ROBOTS_TXT_SITE_URL}/sitemap-index.xml`,
		"",
	];

	return lines.join("\n");
}

/**
 * Parse disallowed routes from robots.txt content.
 * Used by tests to verify the generated content.
 */
export function parseRobotsTxtDisallows(content: string): string[] {
	return content
		.split("\n")
		.filter((line) => line.startsWith("Disallow:"))
		.map((line) => line.replace("Disallow:", "").trim())
		.sort();
}
