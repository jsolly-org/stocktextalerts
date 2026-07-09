#!/usr/bin/env tsx
/**
 * scripts/check-ts.ts — run `astro check` and fail on Vite/Astro logger WARN
 * lines that are not counted in the diagnostic summary.
 *
 * `astro check --minimumFailingSeverity warning` already fails on type/lint
 * diagnostics. Vite can still emit `[WARN] [vite] ...` (e.g. a stale
 * `optimizeDeps.include` entry) while the summary stays at "0 warnings" and
 * exit 0. This wrapper tees stdout/stderr and fails closed on any `[WARN]`.
 *
 * Exit codes: 0 — clean check, no logger WARNs. 1 — diagnostics failed and/or
 * a logger WARN was emitted.
 *
 * Usage: npm run check:ts
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `@astrojs/check` powers `astro check`. Keep the dep referenced so knip does not
// treat it as unused after the npm script moved into this wrapper.
import "@astrojs/check";

import { rootLogger } from "../src/lib/logging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const ACTION = "check_ts";

/** Matches Astro/Vite logger WARN lines (ANSI-safe: looks for the token itself). */
const LOGGER_WARN_RE = /\[WARN\]/;

function main(): void {
	const astroBin = path.join(projectRoot, "node_modules", ".bin", "astro");
	const child = spawn(
		astroBin,
		["check", "--minimumSeverity", "warning", "--minimumFailingSeverity", "warning"],
		{
			cwd: projectRoot,
			env: process.env,
			stdio: ["inherit", "pipe", "pipe"],
		},
	);

	let sawLoggerWarn = false;
	const warnLines: string[] = [];

	const onChunk = (chunk: Buffer, stream: NodeJS.WritableStream): void => {
		stream.write(chunk);
		const text = chunk.toString("utf8");
		if (!LOGGER_WARN_RE.test(text)) return;
		sawLoggerWarn = true;
		for (const line of text.split(/\r?\n/)) {
			if (LOGGER_WARN_RE.test(line)) {
				warnLines.push(line.replace(/\x1b\[[0-9;]*m/g, "").trim());
			}
		}
	};

	child.stdout?.on("data", (chunk: Buffer) => onChunk(chunk, process.stdout));
	child.stderr?.on("data", (chunk: Buffer) => onChunk(chunk, process.stderr));

	child.on("error", (err) => {
		rootLogger.error("check:ts — failed to spawn astro check", { action: ACTION }, err);
		process.exitCode = 1;
	});

	child.on("close", (code, signal) => {
		if (signal) {
			rootLogger.error("check:ts — astro check killed by signal", {
				action: ACTION,
				signal,
			});
			process.exitCode = 1;
			return;
		}

		const exitCode = code ?? 1;
		if (sawLoggerWarn) {
			rootLogger.error("check:ts — logger WARN emitted (failing closed)", {
				action: ACTION,
				warnCount: warnLines.length,
				warnLines,
			});
			process.exitCode = 1;
			return;
		}

		process.exitCode = exitCode === 0 ? 0 : exitCode;
	});
}

main();
