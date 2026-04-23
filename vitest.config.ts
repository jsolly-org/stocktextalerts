import { getViteConfig } from "astro/config";
import { loadEnv } from "vite";

// Force NODE_ENV=test so sender hard-gates (isProduction() in
// src/lib/runtime/mode.ts) correctly mock out Twilio/SES even when the
// shell inherits NODE_ENV=production. Vitest's own injection is
// `??=`-style and won't overwrite an inherited value — see
// tests/run-vitest.ts for the same belt-and-suspenders guard.
process.env.NODE_ENV = "test";

// Load .env / .env.local into process.env so tests work regardless of
// invocation method (npm test, npx vitest, IDE test runner, etc.).
const env = loadEnv("test", process.cwd(), "");
for (const [key, value] of Object.entries(env)) {
	if (process.env[key] === undefined) {
		process.env[key] = value;
	}
}

export default getViteConfig(
	{
		test: {
			setupFiles: ["./tests/setup.ts"],
			include: ["tests/**/*.test.ts"],
			// Run test files sequentially; they share Supabase state and can race otherwise.
			fileParallelism: false,
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
