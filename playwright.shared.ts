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
	// Two workers on the 4-vCPU CI runner (measured: 111s -> 68s for the full e2e suite;
	// the box also carries Astro dev and the Supabase containers, so this is not a free
	// dial to turn up). Specs already isolate their own users, and the one piece of
	// genuinely shared state, the Mailpit inbox, is now cleared per recipient rather than
	// globally (tests/helpers/mailpit.ts). Raising this needs the same check: what does a
	// spec read that another spec can write?
	workers: 2,
	// Global retries mask serial-suite state bugs; routes.e2e.spec.ts opts in locally.
	retries: 0,
	outputDir: ".playwright-mcp/cli",
	use: sharedUse,
} satisfies Pick<PlaywrightTestConfig, "workers" | "retries" | "outputDir" | "use">;
