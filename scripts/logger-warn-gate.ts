/**
 * scripts/logger-warn-gate.ts — spawn a child and fail closed on Astro/Vite
 * logger `[WARN]` lines that are not counted as diagnostics.
 *
 * Shared by `check:ts` and `build` so a stale optimizeDeps entry (or similar)
 * cannot exit 0 while printing WARN. No allowlist — suppress third-party noise
 * at the bundler (e.g. `vite.build.rolldownOptions.onLog`) instead.
 */

import { spawn } from "node:child_process";

import { rootLogger } from "../src/lib/logging";

/** Matches Astro/Vite logger WARN lines (ANSI-safe: looks for the token itself). */
const LOGGER_WARN_RE = /\[WARN\]/;

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export type LoggerWarnGateOptions = {
	action: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
};

function stripAnsi(line: string): string {
	return line.replace(ANSI_RE, "").trim();
}

/**
 * Spawn `command` with `args`, tee stdout/stderr, and set `process.exitCode`
 * when the child exits. Fails closed on any `[WARN]` line.
 *
 * Buffers incomplete trailing lines so a `[WARN]` split across chunks cannot
 * slip through.
 */
export function runWithLoggerWarnGate(
	command: string,
	args: string[],
	options: LoggerWarnGateOptions,
): void {
	const { action, cwd, env = process.env } = options;

	const child = spawn(command, args, {
		cwd,
		env,
		stdio: ["inherit", "pipe", "pipe"],
	});

	let sawLoggerWarn = false;
	const warnLines: string[] = [];
	let stdoutCarry = "";
	let stderrCarry = "";

	const scanCompleteLines = (text: string, carry: string): string => {
		const combined = carry + text;
		const parts = combined.split(/\r?\n/);
		const nextCarry = parts.pop() ?? "";
		for (const raw of parts) {
			if (!LOGGER_WARN_RE.test(raw)) continue;
			sawLoggerWarn = true;
			warnLines.push(stripAnsi(raw));
		}
		return nextCarry;
	};

	const flushCarry = (carry: string): void => {
		if (!carry || !LOGGER_WARN_RE.test(carry)) return;
		sawLoggerWarn = true;
		warnLines.push(stripAnsi(carry));
	};

	const onChunk = (
		chunk: Buffer,
		stream: NodeJS.WritableStream,
		which: "stdout" | "stderr",
	): void => {
		stream.write(chunk);
		const text = chunk.toString("utf8");
		if (which === "stdout") {
			stdoutCarry = scanCompleteLines(text, stdoutCarry);
		} else {
			stderrCarry = scanCompleteLines(text, stderrCarry);
		}
	};

	child.stdout?.on("data", (chunk: Buffer) => onChunk(chunk, process.stdout, "stdout"));
	child.stderr?.on("data", (chunk: Buffer) => onChunk(chunk, process.stderr, "stderr"));

	child.on("error", (err) => {
		rootLogger.error(`${action} — failed to spawn`, { action }, err);
		process.exitCode = 1;
	});

	child.on("close", (code, signal) => {
		flushCarry(stdoutCarry);
		flushCarry(stderrCarry);

		if (signal) {
			rootLogger.error(`${action} — killed by signal`, { action, signal });
			process.exitCode = 1;
			return;
		}

		const exitCode = code ?? 1;
		if (sawLoggerWarn) {
			rootLogger.error(`${action} — logger WARN emitted (failing closed)`, {
				action,
				warnCount: warnLines.length,
				warnLines,
			});
			process.exitCode = 1;
			return;
		}

		process.exitCode = exitCode === 0 ? 0 : exitCode;
	});
}
