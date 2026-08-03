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
	// Vitest's console output is auto-parsed by Blacksmith test analytics, so the unit
	// suite already has per-test timings and failure history (`blacksmith jobs tests
	// <job_id>`). Playwright's default reporter is not, so the e2e job (the one with the
	// documented Mailpit/GoTrue timing flake) reported *zero* structured tests. A JUnit
	// file written anywhere on disk during the job is picked up automatically (no workflow
	// change, no artifact upload), which is what makes a flake measurable after the fact
	// instead of a re-run and a shrug. `list` keeps the human-readable log; the default
	// in CI is `dot`, which is also what auto-parsing choked on.
	reporter: [["list"], ["junit", { outputFile: "test-results/playwright-junit.xml" }]],
	use: sharedUse,
} satisfies Pick<PlaywrightTestConfig, "workers" | "retries" | "outputDir" | "reporter" | "use">;
