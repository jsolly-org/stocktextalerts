#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";

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
		const arg = args[i];
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
		(arg) =>
			arg === "--watch" || arg === "--no-watch" || arg === "--watch=false",
	);
	if (hasWatchArg) return vitestArgs;
	return ["--no-watch", ...vitestArgs];
}

/**
 * Parse an `--live=a,b,c` list and strip any providers we refuse to
 * enable from the test harness. Currently:
 *
 *   - `sms` is dropped unconditionally. `--live=sms` was removed on
 *     2026-04-11 — the harness had no way to prevent real-number
 *     delivery or per-message Twilio charges, and SMS code paths are
 *     now covered by unit/integration tests with mocks only. See
 *     AGENTS.md#testing-philosophy.
 */
function filterLiveProviders(raw: string): string {
	if (raw.trim().toLowerCase() === "all") {
		// Expand "all" so we can drop the disallowed providers cleanly.
		return ["massive", "finnhub", "xai", "email"].join(",");
	}
	return raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item && item.toLowerCase() !== "sms")
		.join(",");
}

/**
 * Entry point for a small Vitest wrapper that:
 * - optionally enables live providers for specific tests
 * - routes live email tests through local Mailpit (no real SES)
 * - forces `--no-watch` by default
 * - exits with the child process status code
 */
function main() {
	const { liveProviders, vitestArgs } = parseArgs(process.argv.slice(2));
	const filtered =
		liveProviders !== null ? filterLiveProviders(liveProviders) : "";
	const liveEmail = filtered.split(",").some((item) => item.trim() === "email");

	// Surface silent drops so `--live=sms` doesn't look like a quiet success.
	if (liveProviders !== null) {
		const requested = new Set(
			liveProviders
				.split(",")
				.map((item) => item.trim().toLowerCase())
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
			// biome-ignore lint/suspicious/noConsole: this is a dev-facing CLI
			console.warn(
				`run-vitest: ignoring unsupported --live provider(s): ${dropped.join(", ")}. ` +
					"SMS has no live tier — see AGENTS.md#testing-philosophy.",
			);
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
