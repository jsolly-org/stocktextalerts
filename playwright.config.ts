import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	workers: 1,
	use: {
		baseURL: "http://localhost:4321",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "npm run dev -- --port 4321",
		url: "http://localhost:4321/",
		timeout: 120 * 1000,
		// Always reuse existing server if one is already running on port 4321.
		// This allows developers to run `npm run dev` manually and have Playwright
		// use that instance, avoiding port conflicts and reducing startup time.
		reuseExistingServer: true,
	},
});
