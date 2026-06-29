#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import { normalizeDirectVitestProcessEnv } from "./helpers/test-process-env";
import { stopAstroDevLockAfterHttpTests } from "./helpers/http/server";
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
 * Entry point for a small Vitest wrapper that:
 * - forces `--no-watch` by default
 * - exits with the child process status code
 */
async function main() {
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
		const child = spawnSync("./node_modules/.bin/vitest", args, {
			stdio: "inherit",
			env: process.env,
			shell: process.platform === "win32",
		});
		exitCode = typeof child.status === "number" ? child.status : 1;
	} finally {
		releaseTestLock();
		stopAstroDevLockAfterHttpTests();
	}

	process.exit(exitCode);
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
