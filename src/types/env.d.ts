/// <reference path="../../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly PUBLIC_SUPABASE_URL: string;
	readonly PUBLIC_SUPABASE_ANON_KEY: string;
	readonly PUBLIC_HCAPTCHA_SITE_KEY: string;
	readonly HCAPTCHA_SECRET_KEY: string;
	readonly SUPABASE_SERVICE_ROLE_KEY: string;
	readonly RESEND_API_KEY: string;
	readonly EMAIL_FROM: string;
	readonly CRON_SECRET: string;
	readonly TIMEZONE_CACHE_BUSTER?: string;
}
