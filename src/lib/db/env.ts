/* =============
Environment Helpers
============= */

/**
 * Compute the canonical site base URL for links in emails/SMS.
 *
 * Prefers the production domain (when available) over a deployment-specific Vercel URL.
 */
export function getSiteUrl(): string {
	// Prefer VERCEL_PROJECT_PRODUCTION_URL (custom domain like "stocktextalerts.com")
	// over VERCEL_URL which is the deployment-specific URL (e.g., "app-abc123.vercel.app")
	const url =
		import.meta.env.VERCEL_PROJECT_PRODUCTION_URL || import.meta.env.VERCEL_URL;

	// Locally, VERCEL_URL includes the protocol (e.g., "http://localhost:4321")
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return url;
	}
	return `https://${url}`;
}
