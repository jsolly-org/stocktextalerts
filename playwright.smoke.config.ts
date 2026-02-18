import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/smoke",
	testMatch: "**/*.smoke.spec.ts",
	workers: 1,
	use: {
		baseURL: "http://localhost:4322",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "MODE=test npm run dev -- --port 4322",
		url: "http://localhost:4322/",
		timeout: 120 * 1000,
		reuseExistingServer: true,
	},
});
