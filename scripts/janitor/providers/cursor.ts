/**
 * Cursor agent provider — default backend for the scheduled janitor.
 *
 * Installs the Cursor CLI (`curl https://cursor.com/install`) and runs a
 * headless pass via `agent -p --force`. Auth: `CURSOR_API_KEY`.
 *
 * Docs: https://cursor.com/docs/cli/github-actions
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProvider, AgentRunOptions, AgentRunResult } from "../types";
import {
	ensureAgentBinsOnPath,
	requireEnv,
	spawnAgent,
	which,
} from "../spawn";

async function installCursorCli(): Promise<void> {
	ensureAgentBinsOnPath();
	const existing = (await which("agent")) ?? (await which("cursor-agent"));
	if (existing) return;

	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"bash",
			["-lc", "curl https://cursor.com/install -fsS | bash"],
			{ stdio: "inherit" },
		);
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Cursor CLI install failed (exit ${code})`));
		});
	});

	ensureAgentBinsOnPath();
}

async function resolveAgentBin(): Promise<string> {
	ensureAgentBinsOnPath();
	const bin = (await which("agent")) ?? (await which("cursor-agent"));
	if (!bin) {
		throw new Error(
			"Cursor CLI not found on PATH after install (expected `agent` or `cursor-agent`)",
		);
	}
	return bin;
}

export const cursorProvider: AgentProvider = {
	id: "cursor",
	apiKeyEnv: "CURSOR_API_KEY",

	async ensureInstalled() {
		requireEnv(this.apiKeyEnv);
		await installCursorCli();
		await resolveAgentBin();
	},

	async run(opts: AgentRunOptions): Promise<AgentRunResult> {
		requireEnv(this.apiKeyEnv);
		const bin = await resolveAgentBin();
		const args = ["-p", "--force", "--output-format", "text"];
		if (opts.model) {
			args.push("--model", opts.model);
		}
		args.push(opts.prompt);

		const logFile = join(
			process.env.RUNNER_TEMP ?? tmpdir(),
			"janitor-cursor.log",
		);

		return spawnAgent({
			cmd: bin,
			args,
			cwd: opts.cwd,
			timeoutSeconds: opts.timeoutSeconds,
			logFile,
			env: {
				CURSOR_API_KEY: process.env.CURSOR_API_KEY,
				// Prefer non-interactive; some builds also read this.
				CURSOR_AGENT_FORCE: "1",
			},
		});
	},
};
