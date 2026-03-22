import { defineConfig } from "@playwright/test";
import { loadEnv } from "vite";

// Load .env / .env.local so E2E test helpers (which run in plain Node, not
// Vite) can access env vars like SUPABASE_URL via process.env.
const env = loadEnv("test", process.cwd(), "");
for (const [key, value] of Object.entries(env)) {
	if (process.env[key] === undefined) {
		process.env[key] = value;
	}
}

export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "**/*.e2e.spec.ts",
	// Run e2e sequentially; parallel workers can race on shared DB/auth state.
	workers: 1,
	use: {
		baseURL: "http://localhost:4322",
		// Keep traces only when a test fails; reduces output and helps debug.
		trace: "retain-on-failure",
		browserName: "chromium",
	},
	webServer: {
		command: "MODE=test npm run dev -- --port 4322",
		url: "http://localhost:4322/",
		timeout: 120 * 1000,
		// Use 4322 to avoid clashing with default Astro dev (4321). Reuse server on 4322 when present.
		reuseExistingServer: true,
	},
});
