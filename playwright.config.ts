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
		reuseExistingServer: true,
	},
});
