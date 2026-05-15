import type { PlaywrightTestConfig } from "@playwright/test";
import { loadEnv } from "vite";

// Load .env / .env.local so Playwright helpers (plain Node) can use process.env.
const env = loadEnv("test", process.cwd(), "");
for (const [key, value] of Object.entries(env)) {
	if (process.env[key] === undefined) {
		process.env[key] = value;
	}
}

const sharedUse: PlaywrightTestConfig["use"] = {
	trace: "retain-on-failure",
	browserName: "chromium",
};

export const sharedDefaults = {
	workers: 1,
	outputDir: ".playwright-mcp/cli",
	use: sharedUse,
} satisfies Pick<PlaywrightTestConfig, "workers" | "outputDir" | "use">;
