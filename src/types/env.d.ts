/// <reference path="../../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly SUPABASE_URL: string;
	readonly SUPABASE_PUBLISHABLE_KEY: string;
	readonly SUPABASE_SECRET_KEY: string;
	readonly RESEND_API_KEY: string;
	readonly EMAIL_FROM: string;
	readonly EMAIL_REPLY_TO?: string;
	readonly CRON_SECRET: string;
	readonly FINNHUB_API_KEY: string;
	readonly TIMEZONE_CACHE_BUSTER?: string;
	readonly SMS_TEST_BEHAVIOR?: "success" | "fail";
	readonly SMS_TEST_MESSAGE_SID?: string;
	readonly SMS_TEST_ERROR?: string;
	readonly SMS_TEST_ERROR_CODE?: string;
}

declare module "*.svg?component" {
	import type { DefineComponent } from "vue";
	const component: DefineComponent;
	export default component;
}
