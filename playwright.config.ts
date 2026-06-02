import { defineConfig } from "@playwright/test";
import { sharedDefaults } from "./playwright.shared";

export default defineConfig({
	...sharedDefaults,
	testDir: "./tests/e2e",
	testMatch: "**/*.e2e.spec.ts",
	use: {
		...sharedDefaults.use,
		baseURL: "http://localhost:4322",
	},
	webServer: {
		command: "MODE=test npm run dev -- --port 4322",
		url: "http://localhost:4322/",
		timeout: 120 * 1000,
		// Use 4322 to avoid clashing with default Astro dev (4321). Reuse server on 4322 when present.
		reuseExistingServer: true,
		env: {
			// CI uses placeholder API keys; avoid vendor retry storms during E2E (vendor-fetch.ts).
			SKIP_VENDOR_HTTP_IN_TEST: "1",
		},
	},
});
