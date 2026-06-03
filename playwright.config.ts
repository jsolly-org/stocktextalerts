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
			// Deterministic admin allowlist for tests/e2e/admin-users.e2e.spec.ts,
			// independent of whatever .env.local / CI static vars contain.
			APPROVAL_ADMIN_EMAILS: "admin-e2e@example.com",
			EMAIL_FROM: "StockTextAlerts <notifications@example.com>",
			EMAIL_SMTP_HOST: "localhost",
			EMAIL_SMTP_PORT: "1025",
			SITE_URL: "http://localhost:4322",
		},
	},
});
