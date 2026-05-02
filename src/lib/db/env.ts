/* =============
Environment Helpers
============= */

/**
 * Read an environment variable at runtime.
 *
 * Astro loads `.env.local` into `process.env` for both dev and SSR, and
 * Lambda injects env vars through `process.env` directly, so a single
 * `process.env` lookup covers every runtime. For required env vars, prefer
 * `requireEnv()` which throws on missing values and returns `string` (no
 * cast needed). Use `readEnv()` directly only for genuinely optional
 * variables.
 */
export function readEnv(name: string): string | undefined {
	const fromProcess = process.env[name];
	if (typeof fromProcess === "string" && fromProcess.trim() !== "") {
		return fromProcess;
	}
	return undefined;
}

/**
 * Read a required environment variable. Throws if missing or blank.
 *
 * Use this for env vars that MUST be present at runtime. Each module
 * validates the vars it needs at point-of-use rather than centrally,
 * so errors surface only when a code path that needs the var is hit.
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

/** Minimum length for UNSUBSCRIBE_TOKEN_SECRET. */
const UNSUBSCRIBE_SECRET_MIN_LENGTH = 12;

/**
 * Returns UNSUBSCRIBE_TOKEN_SECRET if it meets policy (format + minimum length).
 * Used to HMAC-sign email unsubscribe tokens.
 */
export function getValidatedUnsubscribeTokenSecret(): string | null {
	const value = getUnsubscribeTokenSecret();
	if (typeof value !== "string" || value.trim().length < UNSUBSCRIBE_SECRET_MIN_LENGTH) {
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
		readEnv("SITE_URL") || readEnv("VERCEL_PROJECT_PRODUCTION_URL") || readEnv("VERCEL_URL");

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
