import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/routing",
	testMatch: "**/*.e2e.spec.ts",
	// Run e2e sequentially; parallel workers can race on shared DB/auth state.
	workers: 1,
	use: {
		baseURL: "http://localhost:4322",
		// Keep traces only when a test fails; reduces output and helps debug.
		trace: "retain-on-failure",
	},
	webServer: {
		command: "npm run dev -- --port 4322",
		url: "http://localhost:4322/",
		timeout: 120 * 1000,
		// Use 4322 to avoid clashing with default Astro dev (4321). Reuse server on 4322 when present.
		reuseExistingServer: true,
	},
});
