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
		import.meta.env.VERCEL_PROJECT_PRODUCTION_URL ||
		import.meta.env.VERCEL_URL ||
		process.env.VERCEL_PROJECT_PRODUCTION_URL ||
		process.env.VERCEL_URL;

	if (!url || url.trim() === "") {
		throw new Error(
			"Site URL is not configured. Set VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL.",
		);
	}
	const trimmed = url.trim();

	// Locally, VERCEL_URL includes the protocol (e.g., "http://localhost:4321")
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return trimmed;
	}
	return `https://${trimmed}`;
}
