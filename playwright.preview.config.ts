/**
 * Playwright config for E2E tests against a production-equivalent build.
 *
 * The Vercel adapter does not support `astro preview`, so we swap in
 * @astrojs/node via ASTRO_ADAPTER=node. The Vite build pipeline (code-
 * splitting, CSS chunk extraction, asset hashing) is identical regardless of
 * adapter, so this catches production-only bugs — such as phantom CSS chunk
 * references — that the dev server would miss.
 *
 * Usage:
 *   npm run test:e2e:preview
 */
import { defineConfig } from "@playwright/test";
import { sharedDefaults } from "./playwright.shared";

export default defineConfig({
	...sharedDefaults,
	testDir: "./tests/e2e",
	testMatch: "**/*.e2e.spec.ts",
	use: {
		...sharedDefaults.use,
		baseURL: "http://localhost:4323",
	},
	webServer: {
		command:
			"MODE=test npm run build:preview && ASTRO_ADAPTER=node MODE=test npx astro preview --port 4323",
		url: "http://localhost:4323/",
		// Build + start is slower than dev server.
		timeout: 180 * 1000,
		reuseExistingServer: true,
		env: {
			SKIP_VENDOR_HTTP_IN_TEST: "1",
		},
	},
});
