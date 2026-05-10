#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import { acquireTestLock, formatContentionMessage, TestLockHeldError } from "./lock";

interface ParsedArgs {
	liveProviders: string | null;
	vitestArgs: string[];
}

/**
 * Parse CLI args for this wrapper script.
 *
 * Supports `--live=<providers>` (or `--live <providers>`) to set `LIVE_API_PROVIDERS`,
 * and forwards all remaining args through to Vitest.
 */
function parseArgs(args: string[]): ParsedArgs {
	let liveProviders: string | null = null;
	const vitestArgs: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg.startsWith("--live=")) {
			liveProviders = arg.slice("--live=".length);
			continue;
		}
		if (arg === "--live") {
			liveProviders = args[i + 1] ?? "";
			i += 1;
			continue;
		}
		vitestArgs.push(arg);
	}

	return { liveProviders, vitestArgs };
}

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
 * Parse an `--live=a,b,c` list and normalize provider aliases.
 *
 * `sms` is retained as a backward-compatible alias for `twilio`.
 */
function filterLiveProviders(raw: string): string {
	if (raw.trim().toLowerCase() === "all") {
		return ["massive", "finnhub", "xai", "email", "twilio"].join(",");
	}
	const normalized = raw
		.split(",")
		.map((item) => item.trim())
		.map((item) => (item.toLowerCase() === "sms" ? "twilio" : item))
		.filter(Boolean);
	return [...new Set(normalized)].join(",");
}

/**
 * Entry point for a small Vitest wrapper that:
 * - optionally enables live providers for specific tests
 * - routes live email tests through local Mailpit (no real SES)
 * - forces `--no-watch` by default
 * - exits with the child process status code
 */
function main() {
	// Force NODE_ENV=test regardless of what the shell inherits. The sender
	// hard-gates in src/lib/messaging/ and src/lib/auth/ call isProduction()
	// which reads process.env.NODE_ENV, and Vitest only sets NODE_ENV via
	// `??=` — it won't overwrite an inherited `NODE_ENV=production` from the
	// shell. Without this line, a developer with `NODE_ENV=production` in
	// their shell rc would silently route real Twilio/SES calls during
	// tests (the 2026-04-11 incident class).
	process.env.NODE_ENV = "test";

	try {
		acquireTestLock("vitest");
	} catch (err) {
		if (err instanceof TestLockHeldError) {
			process.stderr.write(formatContentionMessage(err));
			process.exit(1);
		}
		throw err;
	}

	const { liveProviders, vitestArgs } = parseArgs(process.argv.slice(2));
	const filtered = liveProviders !== null ? filterLiveProviders(liveProviders) : "";
	const liveEmail = filtered.split(",").some((item) => item.trim() === "email");

	// Surface unsupported providers so typos don't look like silent success.
	if (liveProviders !== null) {
		const isAllKeyword = liveProviders.trim().toLowerCase() === "all";
		if (!isAllKeyword) {
			const requested = new Set(
				liveProviders
					.split(",")
					.map((item) => item.trim().toLowerCase())
					.map((item) => (item === "sms" ? "twilio" : item))
					.filter(Boolean),
			);
			const kept = new Set(
				filtered
					.split(",")
					.map((item) => item.trim().toLowerCase())
					.filter(Boolean),
			);
			const dropped = [...requested].filter((item) => !kept.has(item));
			if (dropped.length > 0) {
				console.warn(
					`run-vitest: ignoring unsupported --live provider(s): ${dropped.join(", ")}. ` +
						"See tests/helpers/live-api.ts for allowed provider keys.",
				);
			}
		}
	}

	if (liveProviders !== null) {
		process.env.LIVE_API_PROVIDERS = filtered;
	}

	// `--live=email` routes through local Mailpit via SMTP on localhost:1025.
	// createEmailSender picks up EMAIL_SMTP_HOST and uses nodemailer instead
	// of SES. The harness must never set real AWS credentials for email
	// tests. For every OTHER vitest run — including plain `npm test` — we
	// strip EMAIL_SMTP_HOST even if it's set in `.env.local` (where it
	// exists so `astro dev` can render emails into Mailpit locally). Leaving
	// it set in unit tests would make `createEmailSender` return a real
	// nodemailer transport that tries to open a TCP connection inside a
	// fake-timer sandbox — which deadlocks because SMTP connect-timeouts
	// are setTimeout-based.
	if (liveEmail) {
		process.env.EMAIL_SMTP_HOST = process.env.EMAIL_SMTP_HOST ?? "localhost";
		process.env.EMAIL_SMTP_PORT = process.env.EMAIL_SMTP_PORT ?? "1025";
	} else {
		process.env.EMAIL_SMTP_HOST = "";
		process.env.EMAIL_SMTP_PORT = "";
	}

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

main();
