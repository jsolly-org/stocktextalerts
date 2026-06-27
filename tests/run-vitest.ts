#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import { acquireTestLockWithRetry, formatContentionMessage, TestLockHeldError } from "./lock";

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
	// Force NODE_ENV=test regardless of what the shell inherits. Vitest only
	// sets NODE_ENV via `??=` — it won't overwrite an inherited
	// `NODE_ENV=production` from the shell.
	process.env.NODE_ENV = "test";

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

	// Strip EMAIL_SMTP_HOST even if it's set in `.env.local` (where it exists
	// so `astro dev` can render emails into Mailpit locally). Leaving it set in
	// unit tests would make `createEmailSender` return a real nodemailer
	// transport that tries to open a TCP connection inside a fake-timer
	// sandbox — which deadlocks because SMTP connect-timeouts are
	// setTimeout-based. EMAIL_SMTP_PORT is left intact (1025 on the shared local
	// stack) so tests that explicitly opt into SMTP (e.g. sender-gates) reach the
	// correct Mailpit port.
	process.env.EMAIL_SMTP_HOST = "";

	// CI sets SKIP_VENDOR_HTTP_IN_TEST for E2E/build (dummy API keys). Vitest
	// unit tests mock global fetch instead — leaving the flag set makes
	// marketDataFetch/finnhubFetch return null before fetch runs.
	delete process.env.SKIP_VENDOR_HTTP_IN_TEST;

	const args = ensureNoWatch(vitestArgs);

	const child = spawnSync("./node_modules/.bin/vitest", args, {
		stdio: "inherit",
		env: process.env,
		shell: process.platform === "win32",
	});

	if (typeof child.status === "number") {
		process.exit(child.status);
	}
	process.exit(1);
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
