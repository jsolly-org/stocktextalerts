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
	//
	// 3 was measured and rejected (PR #689), so don't re-derive it from the scheduling
	// math alone. Playwright parallelizes by file, and per-suite timings said 3 should
	// win: 165.9s of test time over 9 files, longest 42.7s, so a ~87s makespan at 2
	// workers against ~59s at 3. What actually happened on the runner is that the box is
	// already CPU-saturated, so the third worker mostly inflated the work rather than
	// absorbing it:
	//
	//   workers  E2E step        total test time  slowest single test
	//   2        136-140s        165.9s           15.0s
	//   3        121s / 133s     224.8s (+35%)    23.4s (auth-onboarding, was 5.1s)
	//
	// ~11s of mean gain on a ~218s job, bought with 4.6x inflation on the slowest test
	// and a 12s run-to-run spread (vs 4s at 2 workers). With `retries: 0` and a
	// documented Mailpit/GoTrue timing flake, that margin is worth more than the 11s.
	// Reconsider only on a runner with more vCPU, not on this one.
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
