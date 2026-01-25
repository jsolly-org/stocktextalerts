import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import icon from "astro-icon";
import vercel from "@astrojs/vercel";
import vue from "@astrojs/vue";
import { loadEnv } from "vite";

// Config runs before Vite loads .env*; loadEnv makes .env / .env.local available here.
const mode = process.env.NODE_ENV || process.env.MODE || "development";
const env = loadEnv(mode, process.cwd(), "");
// Prefer loaded env (.env.local), then process.env (shell, Vercel).
const vercelUrl = env.VERCEL_URL || process.env.VERCEL_URL;

// CI is set by the runner (e.g. GitHub Actions), not .env.local.
const isCI = process.env.CI === "true";

// VERCEL_URL from Vercel is just the hostname (e.g., "stocktextalerts.com").
// Locally, use full URL with protocol (e.g., "http://localhost:4321").
// In CI, VERCEL_URL may be unset (e.g. unit tests); use a placeholder so config still works.
let site: string;
if (!vercelUrl) {
	if (isCI) {
		site = "https://placeholder.example.com";
	} else {
		throw new Error(
			"VERCEL_URL is not configured. VERCEL_URL is automatically set by Vercel. For local development, set VERCEL_URL=http://localhost:4321 in your .env.local file.",
		);
	}
} else if (vercelUrl.startsWith("http://") || vercelUrl.startsWith("https://")) {
	site = vercelUrl;
} else {
	site = `https://${vercelUrl}`;
}

// https://astro.build/config
export default defineConfig({
    output: "server",
    adapter: vercel({
        // Enable if you later use edge middleware helpers; keep serverless for Supabase SSR consistency
        edgeMiddleware: false,
    }),

	site,

	integrations: [
		sitemap({}),
		icon(),
		vue(),
	],

	vite: {
		plugins: [tailwindcss()],
		// Pre-bundle Vue and dashboard deps so SSR/client resolve them without issues.
		optimizeDeps: {
			include: ['vue', '@vueuse/core', 'fuse.js', 'libphonenumber-js'],
		},
	},
});
