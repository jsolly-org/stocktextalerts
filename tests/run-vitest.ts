#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import { assertLocalDbTestsAllowed } from "./guard-local-db-tests";
import { stopAstroDevLockAfterHttpTests } from "./helpers/http/server";
import { normalizeDirectVitestProcessEnv } from "./helpers/test-process-env";
import {
	acquireTestLockWithRetry,
	formatContentionMessage,
	releaseTestLock,
	TestLockHeldError,
} from "./lock";

/**
 * Ensure Vitest runs without watch mode unless explicitly set.
 *
 * This is important for CI and for scripts that would otherwise hang.
 */
function ensureNoWatch(vitestArgs: string[]): string[] {
	const hasWatchArg = vitestArgs.some(
		(arg) => arg === "--watch" || arg === "--no-watch" || arg === "--watch=false",
	);
	if (hasWatchArg) return vitestArgs;
	return ["--no-watch", ...vitestArgs];
}

/**
 * A positional argument means the caller picked files by hand (`npm test -- some.test.ts`).
 * Splitting a hand-picked subset into two passes is pointless and can leave a pass with no
 * matching files, so those runs stay single-pass.
 */
function hasFileFilter(vitestArgs: string[]): boolean {
	return vitestArgs.some((arg) => !arg.startsWith("-"));
}

function runPass(pass: "all" | "parallel" | "serial", args: string[]): number {
	const child = spawnSync("./node_modules/.bin/vitest", args, {
		stdio: "inherit",
		env: { ...process.env, VITEST_PASS: pass },
		shell: process.platform === "win32",
	});
	return typeof child.status === "number" ? child.status : 1;
}

/**
 * The full suite runs in two passes: everything that tolerates parallelism, then the handful of
 * files that need the database or the HTTP test port to themselves (tests/serial-test-files.ts).
 * The parallel pass carries nearly every file, so it sets the wall clock.
 *
 * The serial tail was 39.5s against the parallel pass's 81.3s on CI job 91709170896, i.e. a
 * third of the unit suite's test time spent one file at a time. 18.7s of that was the two
 * `tests/pages/http/**` files, which have since moved back into the parallel pass (see
 * tests/serial-test-files.ts). What is left is the reconcile and scheduler specs, whose
 * subject is the whole `assets`/scheduling table. Re-measure with
 * `blacksmith jobs tests <job_id> --summary suites` before changing the split again.
 *
 * Both passes always run, and the run fails if either does.
 */
function runFullSuite(args: string[]): number {
	const parallelExit = runPass("parallel", args);
	// --passWithNoTests: a future --shard split can legitimately leave this pass empty.
	const serialExit = runPass("serial", [...args, "--passWithNoTests"]);
	return parallelExit !== 0 ? parallelExit : serialExit;
}

/**
 * Entry point for a small Vitest wrapper that:
 * - forces `--no-watch` by default
 * - runs the parallel and serial passes for a full-suite run
 * - exits with the child process status code
 */
async function main() {
	assertLocalDbTestsAllowed("vitest");
	normalizeDirectVitestProcessEnv();

	try {
		await acquireTestLockWithRetry("vitest");
	} catch (err) {
		if (err instanceof TestLockHeldError) {
			process.stderr.write(formatContentionMessage(err));
			process.exit(1);
		}
		throw err;
	}

	const vitestArgs = process.argv.slice(2);
	const args = ensureNoWatch(vitestArgs);

	let exitCode = 1;
	try {
		exitCode = hasFileFilter(vitestArgs) ? runPass("all", args) : runFullSuite(args);
	} finally {
		releaseTestLock();
		stopAstroDevLockAfterHttpTests();
	}

	process.exit(exitCode);
}

const isMain =
	typeof process.argv[1] === "string" && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
	main().catch((err) => {
		process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(1);
	});
}
