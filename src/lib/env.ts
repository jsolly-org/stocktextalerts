/* =============
Environment Validation
============= */

interface RequiredEnvVars {
	PUBLIC_SUPABASE_URL: string;
	PUBLIC_SUPABASE_ANON_KEY: string;
	PUBLIC_HCAPTCHA_SITE_KEY: string;
	HCAPTCHA_SECRET_KEY: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	TWILIO_ACCOUNT_SID: string;
	TWILIO_AUTH_TOKEN: string;
	TWILIO_PHONE_NUMBER: string;
	TWILIO_VERIFY_SERVICE_SID: string;
	CRON_SECRET: string;
	RESEND_API_KEY: string;
	EMAIL_FROM: string;
}

const REQUIRED_ENV_VARS: (keyof RequiredEnvVars)[] = [
	"PUBLIC_SUPABASE_URL",
	"PUBLIC_SUPABASE_ANON_KEY",
	"PUBLIC_HCAPTCHA_SITE_KEY",
	"HCAPTCHA_SECRET_KEY",
	"SUPABASE_SERVICE_ROLE_KEY",
	"TWILIO_ACCOUNT_SID",
	"TWILIO_AUTH_TOKEN",
	"TWILIO_PHONE_NUMBER",
	"TWILIO_VERIFY_SERVICE_SID",
	"CRON_SECRET",
	"RESEND_API_KEY",
	"EMAIL_FROM",
];

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

export function getSiteUrl(): string {
	const vercelUrl = import.meta.env.VERCEL_URL;
	if (!vercelUrl) {
		throw new Error(
			"VERCEL_URL is not configured. VERCEL_URL is automatically set by Vercel. For local development, set VERCEL_URL=http://localhost:4321 in your .env.local file.",
		);
	}

	// VERCEL_URL from Vercel is just the hostname (e.g., "stocktextalerts.com")
	// Locally, it should include the protocol (e.g., "http://localhost:4321")
	if (vercelUrl.startsWith("http://") || vercelUrl.startsWith("https://")) {
		return vercelUrl;
	}
	return `https://${vercelUrl}`;
}
