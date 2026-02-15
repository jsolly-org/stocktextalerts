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
		(arg) => arg === "--watch" || arg === "--no-watch" || arg === "--watch=false",
	);
	if (hasWatchArg) return vitestArgs;
	return ["--no-watch", ...vitestArgs];
}

/**
 * Entry point for a small Vitest wrapper that:
 * - optionally enables live providers for specific tests
 * - forces `--no-watch` by default
 * - exits with the child process status code
 */
function main() {
	const { liveProviders, vitestArgs } = parseArgs(process.argv.slice(2));
	if (liveProviders !== null) {
		process.env.LIVE_API_PROVIDERS = liveProviders;
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
