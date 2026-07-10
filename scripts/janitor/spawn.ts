/**
 * Shared spawn helper for headless agent CLIs.
 *
 * Wraps `spawn` with a wall-clock timeout (Cursor CLI has a known hang-after-
 * completion failure mode in GHA) and captures a truncated stdout/stderr tail
 * for the Actions job summary.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRunResult } from "./types";

const SUMMARY_TAIL_CHARS = 12_000;

export function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required env var ${name}`);
	}
	return value;
}

export function prependPath(dir: string): void {
	const current = process.env.PATH ?? "";
	if (!current.split(":").includes(dir)) {
		process.env.PATH = `${dir}:${current}`;
	}
}

/** Ensure `~/.local/bin` (and common Cursor install dirs) are on PATH. */
export function ensureAgentBinsOnPath(): void {
	const home = homedir();
	for (const dir of [
		join(home, ".local", "bin"),
		join(home, ".cursor", "bin"),
	]) {
		prependPath(dir);
	}
}

export async function which(bin: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", `command -v ${shellQuote(bin)}`], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => {
			const path = out.trim();
			resolve(code === 0 && path ? path : undefined);
		});
	});
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type SpawnAgentOptions = {
	cmd: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeoutSeconds: number;
	/** Optional log file under the runner temp dir for full output. */
	logFile?: string;
};

export async function spawnAgent(
	opts: SpawnAgentOptions,
): Promise<AgentRunResult> {
	const { cmd, args, cwd, timeoutSeconds } = opts;
	const env = { ...process.env, ...opts.env };

	if (opts.logFile) {
		mkdirSync(dirname(opts.logFile), { recursive: true });
	}

	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Rolling tail only — full output (if any) goes to logFile. Avoid OOM on
		// a noisy multi-hour agent pass.
		let combined = "";
		let settled = false;
		const append = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			combined =
				combined.length + text.length > SUMMARY_TAIL_CHARS
					? `${combined}${text}`.slice(-SUMMARY_TAIL_CHARS)
					: combined + text;
			if (opts.logFile) {
				appendFileSync(opts.logFile, text);
			}
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);

		const timer = setTimeout(() => {
			// child.killed is true as soon as SIGTERM is *sent*, not when the
			// process exits — so escalate on !settled, not !child.killed.
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) child.kill("SIGKILL");
			}, 5_000).unref();
		}, timeoutSeconds * 1000);
		timer.unref?.();

		child.on("error", (err) => {
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: 1,
				summary: `Failed to spawn ${cmd}: ${err.message}`,
			});
		});

		child.on("close", (code, signal) => {
			settled = true;
			clearTimeout(timer);
			const exitCode =
				code ?? (signal === "SIGTERM" || signal === "SIGKILL" ? 124 : 1);
			const timedOut = exitCode === 124;
			const tail = combined
				? combined.length >= SUMMARY_TAIL_CHARS
					? `…(truncated)\n${combined}`
					: combined
				: "";
			const summary = timedOut
				? `Agent timed out after ${timeoutSeconds}s (exit 124).\n${tail}`
				: tail || `(no output; exit ${exitCode})`;
			resolve({ exitCode, summary: redactSecrets(summary) });
		});
	});
}

/** Scrub common credential shapes before Actions step summaries / logs. */
export function redactSecrets(text: string): string {
	return text
		.replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_[REDACTED]")
		.replace(/\b(?:gh[pousr]_|gho_)[A-Za-z0-9_]{20,}/g, "[REDACTED_GH_TOKEN]")
		.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]")
		.replace(
			/\b(CURSOR_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY|OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN)=[^\s]+/gi,
			"$1=[REDACTED]",
		)
		.replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]");
}
