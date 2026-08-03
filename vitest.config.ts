/// <reference types="vitest/config" />
import { getViteConfig } from "astro/config";
import { loadEnv } from "vite";
import { normalizeDirectVitestProcessEnv } from "./tests/helpers/test-process-env";
import { SERIAL_TEST_GLOBS } from "./tests/serial-test-files";

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

// Which pass of the two-pass run this config is serving; tests/run-vitest.ts sets it.
// "parallel" = everything except SERIAL_TEST_GLOBS, files in parallel.
// "serial"   = only SERIAL_TEST_GLOBS, one file at a time.
// "all"      = every file in one parallel pass; the default for a direct `npx vitest` or a
//              filtered run (`npm test -- some.test.ts`), where a hand-picked subset is not
//              worth splitting in two.
const pass = process.env.VITEST_PASS ?? "all";

export default getViteConfig(
	{
		test: {
			globalSetup: ["./tests/global-setup.ts"],
			setupFiles: ["./tests/setup.ts"],
			include: pass === "serial" ? SERIAL_TEST_GLOBS : ["tests/**/*.test.ts"],
			// Live vendor HTTP belongs on live-provider-check (Lambda), not default CI Vitest.
			// Opt in locally: LIVE_PREDICTION_MARKETS=1 npx vitest tests/**/*.live.test.ts
			exclude: ["tests/**/*.live.test.ts", ...(pass === "parallel" ? SERIAL_TEST_GLOBS : [])],
			// Files run in parallel. Most of this suite's runtime was never test work: with
			// files serialized, 183 files spent ~105s of a 164s run on per-file module
			// import/isolation rather than on assertions (measured: 59s of actual test
			// time). Four workers put the whole run at ~70s.
			//
			// Two things had to change first: the run-wide user wipe moved out of the
			// per-file hook (tests/global-setup.ts), and the files that genuinely need
			// exclusive database or port access moved to a separate serial pass
			// (tests/serial-test-files.ts). Tests inside a file still run one at a time
			// (sequence.concurrent below), so no test's DB assumptions change.
			fileParallelism: pass !== "serial",
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
