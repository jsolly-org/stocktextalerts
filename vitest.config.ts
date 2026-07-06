/// <reference types="vitest/config" />
import { getViteConfig } from "astro/config";
import { loadEnv } from "vite";
import { normalizeDirectVitestProcessEnv } from "./tests/helpers/test-process-env";

// Load .env / .env.local into process.env so tests work regardless of
// invocation method (npm test, npx vitest, IDE test runner, etc.).
const env = loadEnv("test", process.cwd(), "");
for (const [key, value] of Object.entries(env)) {
	if (process.env[key] === undefined) {
		process.env[key] = value;
	}
}
// After .env merge: strip SMTP host + vendor skip flag (see tests/run-vitest.ts).
normalizeDirectVitestProcessEnv();

export default getViteConfig(
	{
		test: {
			setupFiles: ["./tests/setup.ts"],
			include: ["tests/**/*.test.ts"],
			// Run test files sequentially; they share Supabase state and can race otherwise.
			fileParallelism: false,
			sequence: {
				concurrent: false,
			},
			// Setup runs schema checks and seed preload; allow time.
			hookTimeout: 60000,
			testTimeout: 30000,
		},
	},
	// Minimal Astro override for test env; app code may use site e.g. for URLs.
	{
		site: "http://localhost",
	},
);
