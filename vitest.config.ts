import { getViteConfig } from "astro/config";

export default getViteConfig(
	{
		test: {
			setupFiles: ["./tests/setup.ts"],
			include: ["tests/**/*.test.ts"],
			// Run test files sequentially; they share Supabase state and can race otherwise.
			fileParallelism: false,
			// Setup runs DB reset, schema checks, and seed preload; allow time.
			hookTimeout: 60000,
			testTimeout: 30000,
		},
	},
	// Minimal Astro override for test env; app code may use site e.g. for URLs.
	{
		site: "http://localhost",
	},
);
