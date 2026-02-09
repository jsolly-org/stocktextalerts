/* =============
Environment Validation
============= */

interface RequiredEnvVars {
	SUPABASE_URL: string;
	SUPABASE_PUBLISHABLE_KEY: string;
	SUPABASE_SECRET_KEY: string;
	TWILIO_ACCOUNT_SID: string;
	TWILIO_AUTH_TOKEN: string;
	TWILIO_PHONE_NUMBER: string;
	TWILIO_VERIFY_SERVICE_SID: string;
	CRON_SECRET: string;
	RESEND_API_KEY: string;
	EMAIL_FROM: string;
	VERCEL_URL: string;
	FINNHUB_API_KEY: string;
}

const REQUIRED_ENV_VARS: (keyof RequiredEnvVars)[] = [
	"SUPABASE_URL",
	"SUPABASE_PUBLISHABLE_KEY",
	"SUPABASE_SECRET_KEY",
	"TWILIO_ACCOUNT_SID",
	"TWILIO_AUTH_TOKEN",
	"TWILIO_PHONE_NUMBER",
	"TWILIO_VERIFY_SERVICE_SID",
	"CRON_SECRET",
	"RESEND_API_KEY",
	"EMAIL_FROM",
	"VERCEL_URL",
	"FINNHUB_API_KEY",
];

/**
 * Validate that required runtime environment variables are present and non-empty.
 *
 * Throws a human-readable error listing missing variables.
 */
export function validateEnv(): void {
	const missing: string[] = [];

	for (const varName of REQUIRED_ENV_VARS) {
		const value = import.meta.env[varName];
		if (!value || value.trim() === "") {
			missing.push(varName);
		}
	}

	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variables: ${missing.join(", ")}\n` +
				"Please check your .env file and ensure all required variables are set.",
		);
	}
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
		import.meta.env.VERCEL_PROJECT_PRODUCTION_URL || import.meta.env.VERCEL_URL;

	// Locally, VERCEL_URL includes the protocol (e.g., "http://localhost:4321")
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return url;
	}
	return `https://${url}`;
}
