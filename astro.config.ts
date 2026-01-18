import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";
import vue from "@astrojs/vue";
import { loadEnv } from "vite";

const mode = process.env.NODE_ENV || process.env.MODE || "development";
const env = loadEnv(mode, process.cwd(), "");
const vercelUrl = env.VERCEL_URL || process.env.VERCEL_URL;

const isCI = process.env.CI === "true" || env.CI === "true";

// VERCEL_URL from Vercel is just the hostname (e.g., "stocktextalerts.com")
// Locally, it should include the protocol (e.g., "http://localhost:4321")
// In CI, use a placeholder if VERCEL_URL is not available
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
		vue(),
	],

	vite: {
		plugins: [tailwindcss()],
		optimizeDeps: {
			include: ['vue', '@vueuse/core', 'fuse.js', 'libphonenumber-js'],
		},
	},
});
