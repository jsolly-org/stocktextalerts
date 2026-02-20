// Temporary config for debugging xAI Grok live test in CI.
// Skips the global setup (which requires Supabase/Postgres) and uses a longer timeout.
// Remove this file once the issue is resolved.
import { getViteConfig } from "astro/config";

export default getViteConfig(
	{
		test: {
			setupFiles: [],
			include: ["tests/lib/live-xai-apis.test.ts"],
			fileParallelism: false,
			testTimeout: 120000,
			hookTimeout: 120000,
		},
	},
	{ site: "http://localhost" },
);
