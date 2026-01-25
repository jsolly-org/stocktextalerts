import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	workers: 1,
	use: {
		baseURL: "http://localhost:4322",
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
