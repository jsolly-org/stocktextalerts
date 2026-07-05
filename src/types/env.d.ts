/// <reference path="../../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
	readonly SUPABASE_URL: string;
	readonly SUPABASE_PUBLISHABLE_KEY: string;
	readonly SUPABASE_SECRET_KEY: string;
	readonly AWS_ACCESS_KEY_ID?: string;
	readonly AWS_SECRET_ACCESS_KEY?: string;
	readonly AWS_REGION?: string;
	readonly EMAIL_FROM: string;
	readonly EMAIL_DISPATCH_URL?: string;
	readonly EMAIL_DISPATCH_SECRET?: string;
	readonly ADMIN_EMAILS?: string;
	readonly UNSUBSCRIBE_TOKEN_SECRET: string;
	readonly VERCEL_URL?: string;
	readonly VERCEL_PROJECT_PRODUCTION_URL?: string;
	readonly MASSIVE_API_KEY: string;
	readonly FINNHUB_API_KEY: string;
	readonly TELEGRAM_BOT_TOKEN: string;
	readonly TELEGRAM_BOT_USERNAME: string;
	readonly TELEGRAM_WEBHOOK_SECRET: string;
	readonly TELEGRAM_LINK_TOKEN_SECRET: string;
}

declare module "*.svg?component" {
	import type { DefineComponent } from "vue";

	const component: DefineComponent;
	export default component;
}
