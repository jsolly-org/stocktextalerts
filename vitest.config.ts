import { getViteConfig } from "astro/config";

export default getViteConfig(
	{
		test: {
			setupFiles: ["./tests/setup.ts"],
			include: ["tests/**/*.test.ts"],
			fileParallelism: false,
			hookTimeout: 60000,
			testTimeout: 30000,
		},
	},
	{
		site: "http://localhost",
	},
);
