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
		command:
			"./node_modules/.bin/astro dev stop 2>/dev/null || true; MODE=test npm run dev -- --port 4322",
		url: "http://localhost:4322/",
		timeout: 120 * 1000,
		// Use 4322 to avoid clashing with default Astro dev (4321). Reuse locally only.
		reuseExistingServer: !process.env.CI,
		env: {
			// Deterministic admin allowlist for tests/e2e/admin-users.e2e.spec.ts,
			// independent of whatever .env.local / CI static vars contain.
			ADMIN_EMAILS: "admin-e2e@example.com,workflow-admin-e2e@example.com",
			EMAIL_FROM: "StockTextAlerts <notifications@example.com>",
			EMAIL_SMTP_HOST: "localhost",
			// Mailpit's SMTP port on the shared local stack (default 1025). Inherit it
			// from .env.local (loaded by the test:e2e runner) rather than hardcoding so
			// it stays correct if the shared port is ever changed.
			EMAIL_SMTP_PORT: process.env.EMAIL_SMTP_PORT ?? "1025",
			SITE_URL: "http://localhost:4322",
			// Inbound SMS webhook signature validation (tests/e2e/inbound-sms.e2e.spec.ts).
			TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? "stubaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	},
});
