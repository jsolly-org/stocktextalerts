/* =============
Environment Helpers
============= */

/**
 * Read an environment variable at runtime.
 *
 * Prefers `process.env` (always correct at runtime on Vercel / Node) and falls
 * back to `import.meta.env` for Vite dev-server mode where `.env.local` vars
 * are only loaded into `import.meta.env`.
 *
 * Astro 6 statically inlines `import.meta.env` values at build time, so the
 * fallback may contain stale build-time values in production — but
 * `process.env` will always be checked first in that case.
 *
 * For required env vars, prefer `requireEnv()` which throws on missing values
 * and returns `string` (no cast needed). Use `readEnv()` directly only for
 * genuinely optional variables.
 */
export function readEnv(name: string): string | undefined {
	const fromProcess = process.env[name];
	if (typeof fromProcess === "string" && fromProcess.trim() !== "") {
		return fromProcess;
	}
	try {
		const fromMeta = (
			import.meta.env as unknown as Record<string, string | undefined>
		)[name];
		if (typeof fromMeta === "string" && fromMeta.trim() !== "") {
			return fromMeta;
		}
	} catch {
		// import.meta.env not available outside Vite/Astro
	}
	return undefined;
}

/**
 * Read a required environment variable. Throws if missing or blank.
 *
 * Use this for env vars that MUST be present at runtime. The middleware
 * validates these on first HTTP request, but this also covers Lambda/cron
 * code paths that bypass middleware.
 */
export function requireEnv(name: string): string {
	const value = readEnv(name);
	if (value === undefined) {
		throw new Error(
			`Required environment variable ${name} is not set. ` +
				"Check your .env file or deployment configuration.",
		);
	}
	return value;
}

function getUnsubscribeTokenSecret(): string | undefined {
	return readEnv("UNSUBSCRIBE_TOKEN_SECRET");
}

/** Minimum length for UNSUBSCRIBE_TOKEN_SECRET (policy only; presence is enforced by middleware). */
const UNSUBSCRIBE_SECRET_MIN_LENGTH = 12;

/**
 * Returns UNSUBSCRIBE_TOKEN_SECRET if it meets policy (format + minimum length).
 * Used to HMAC-sign email unsubscribe tokens.
 */
export function getValidatedUnsubscribeTokenSecret(): string | null {
	const value = getUnsubscribeTokenSecret();
	if (
		typeof value !== "string" ||
		value.trim().length < UNSUBSCRIBE_SECRET_MIN_LENGTH
	) {
		return null;
	}
	return value;
}

/**
 * Compute the canonical site base URL for links in emails/SMS.
 *
 * Prefers SITE_URL (explicit override, used in Lambda), then falls back to
 * Vercel-provided variables for dashboard deployments.
 */
export function getSiteUrl(): string {
	const url =
		readEnv("SITE_URL") ||
		readEnv("VERCEL_PROJECT_PRODUCTION_URL") ||
		readEnv("VERCEL_URL");

	if (!url || url.trim() === "") {
		throw new Error(
			"Site URL is not configured. Set SITE_URL, VERCEL_PROJECT_PRODUCTION_URL, or VERCEL_URL.",
		);
	}
	const trimmed = url.trim();

	// Locally, VERCEL_URL includes the protocol (e.g., "http://localhost:4321")
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return trimmed;
	}
	return `https://${trimmed}`;
}
