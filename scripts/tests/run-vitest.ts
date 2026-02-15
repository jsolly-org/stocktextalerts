#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";

interface ParsedArgs {
	liveProviders: string | null;
	vitestArgs: string[];
}

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

function ensureNoWatch(vitestArgs: string[]): string[] {
	const hasWatchArg = vitestArgs.some(
		(arg) => arg === "--watch" || arg === "--no-watch" || arg === "--watch=false",
	);
	if (hasWatchArg) return vitestArgs;
	return ["--no-watch", ...vitestArgs];
}

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
