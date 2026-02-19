import sitemap from "@astrojs/sitemap";
import vercel from "@astrojs/vercel";
import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import icon from "astro-icon";
import { loadEnv } from "vite";
import svgLoader from "vite-svg-loader";
import { EXCLUDED_ROUTE_PREFIXES } from "./src/lib/seo/excluded-routes";

// Config runs before Vite loads .env*; loadEnv makes .env / .env.local available here.
const mode = process.env.NODE_ENV || process.env.MODE || "development";
const env = loadEnv(mode, process.cwd(), "");
// Prefer loaded env (.env.local), then process.env (shell, Vercel).
// VERCEL_PROJECT_PRODUCTION_URL is the canonical production domain (e.g. "stocktextalerts.com").
// VERCEL_URL is the per-deployment URL (e.g. "my-app-abc123.vercel.app") which may be
// blocked by Deployment Protection, breaking OG images and canonical URLs for crawlers.
const vercelProductionUrl =
	env.VERCEL_PROJECT_PRODUCTION_URL ||
	process.env.VERCEL_PROJECT_PRODUCTION_URL;
const vercelUrl =
	vercelProductionUrl || env.VERCEL_URL || process.env.VERCEL_URL;

// CI is set by the runner (e.g. GitHub Actions), not .env.local.
const isCI = process.env.CI === "true";

// Vercel Serverless max duration (seconds).
// Only set this when explicitly configured, since the effective limit depends on
// plan + whether Fluid Compute is enabled for the project.
const maxDurationRaw =
	env.VERCEL_MAX_DURATION || process.env.VERCEL_MAX_DURATION;
const maxDurationParsed = maxDurationRaw
	? Number.parseInt(maxDurationRaw, 10)
	: Number.NaN;
const vercelMaxDurationSeconds =
	maxDurationParsed > 0 ? maxDurationParsed : undefined;

// Locally, use full URL with protocol (e.g., "http://localhost:4321").
// In CI, VERCEL_URL may be unset (e.g. unit tests); use a placeholder so config still works.
let site: string;
if (!vercelUrl) {
	if (isCI) {
		site = "https://placeholder.example.com";
	} else {
		throw new Error(
			"Site URL is not configured. Set VERCEL_PROJECT_PRODUCTION_URL (recommended) or VERCEL_URL. For local development, set VERCEL_URL=http://localhost:4321 in your .env.local file.",
		);
	}
} else if (
	vercelUrl.startsWith("http://") ||
	vercelUrl.startsWith("https://")
) {
	site = vercelUrl;
} else {
	site = `https://${vercelUrl}`;
}

/* Precomputed set for O(1) exact-path exclusion in sitemap filter. */
const EXCLUDED_PATH_SET = new Set(EXCLUDED_ROUTE_PREFIXES);

/**
 * Exclude auth flow, authenticated, and utility pages from the sitemap.
 *
 * These routes have no SEO value and are better left out of crawl budgets.
 */
function sitemapFilter(page: string): boolean {
	const pathname = new URL(page).pathname.replace(/\/$/, "") || "/";
	if (EXCLUDED_PATH_SET.has(pathname)) return false;
	return !EXCLUDED_ROUTE_PREFIXES.some((p) => pathname.startsWith(`${p}/`));
}

// https://astro.build/config
export default defineConfig({
	output: "server",
	adapter: vercel({
		// Enable if you later use edge middleware helpers; keep serverless for Supabase SSR consistency
		edgeMiddleware: false,
		...(vercelMaxDurationSeconds
			? { maxDuration: vercelMaxDurationSeconds }
			: {}),
	}),

	site,
	security: {
		// Keep disabled; same-origin enforcement lives in src/middleware.ts
		// to support proxy-aware origin checks.
		checkOrigin: false,
		allowedDomains: [
			{ protocol: "https", hostname: "stocktextalerts.com" },
			{ protocol: "https", hostname: "www.stocktextalerts.com" },
			{ protocol: "https", hostname: "**.jsollys-projects.vercel.app" },
		],
	},

	trailingSlash: "never",

	integrations: [
		sitemap({
			filter: sitemapFilter,
		}),
		icon(),
		vue(),
	],

	vite: {
		server: {
			// Allow Vite dev server to be accessed through ngrok.
			// Vite treats leading-dot entries as wildcard subdomains.
			allowedHosts: [".ngrok-free.app"],
		},
		plugins: [
			// Astro Icon's <Icon> component cannot be used in Vue components (Astro-only, server-rendered).
			// For Vue components, import SVGs with ?component suffix to get Vue components with render functions.
			(() => {
				const plugin = svgLoader();
				plugin.enforce = "pre";
				return plugin;
			})(),
			tailwindcss(),
		],
		// Pre-bundle Vue and dashboard deps so SSR/client resolve them without issues.
		optimizeDeps: {
			include: ["vue", "@vueuse/core", "libphonenumber-js"],
		},
	},
});
