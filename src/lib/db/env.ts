/* =============
Environment Helpers
============= */

/**
 * Read CRON_SECRET from environment. Prefers import.meta.env (Vite/Astro build),
 * falls back to process.env (Vercel runtime, standalone scripts).
 *
 * Presence is enforced by middleware; this returns the raw value for policy validation.
 */
function getCronSecret(): string | undefined {
	try {
		const fromMeta = import.meta.env.CRON_SECRET;
		if (typeof fromMeta === "string") return fromMeta;
	} catch {
		// import.meta.env not available outside Vite/Astro
	}
	const fromProcess = process.env.CRON_SECRET;
	return typeof fromProcess === "string" ? fromProcess : undefined;
}

/** Minimum length for CRON_SECRET (policy only; presence is enforced by middleware). */
const CRON_SECRET_MIN_LENGTH = 12;

/**
 * Returns CRON_SECRET if it meets policy (format + minimum length).
 * Presence is enforced by middleware; this validates policy only.
 */
export function getValidatedCronSecret(): string | null {
	const value = getCronSecret();
	if (
		typeof value !== "string" ||
		value.trim().length < CRON_SECRET_MIN_LENGTH
	) {
		return null;
	}
	return value;
}

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
