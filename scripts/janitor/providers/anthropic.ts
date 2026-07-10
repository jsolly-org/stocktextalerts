/**
 * Anthropic (Claude Code) agent provider.
 *
 * Installs `@anthropic-ai/claude-code` and runs `claude -p` headless.
 * Auth: `ANTHROPIC_API_KEY`.
 *
 * Swap in via `JANITOR_PROVIDER=anthropic` once the secret is set.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProvider, AgentRunOptions, AgentRunResult } from "../types";
import { ensureAgentBinsOnPath, requireEnv, spawnAgent, which } from "../spawn";

async function installClaudeCode(): Promise<void> {
	ensureAgentBinsOnPath();
	if (await which("claude")) return;

	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"npm",
			["install", "-g", "@anthropic-ai/claude-code"],
			{ stdio: "inherit" },
		);
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`claude-code install failed (exit ${code})`));
		});
	});

	ensureAgentBinsOnPath();
}

export const anthropicProvider: AgentProvider = {
	id: "anthropic",
	apiKeyEnv: "ANTHROPIC_API_KEY",

	async ensureInstalled() {
		requireEnv(this.apiKeyEnv);
		await installClaudeCode();
		if (!(await which("claude"))) {
			throw new Error("claude CLI not found on PATH after install");
		}
	},

	async run(opts: AgentRunOptions): Promise<AgentRunResult> {
		requireEnv(this.apiKeyEnv);
		const args = [
			"-p",
			// Unattended janitor needs shell/git/gh without interactive prompts.
			"--dangerously-skip-permissions",
			"--output-format",
			"text",
		];
		if (opts.model) {
			args.push("--model", opts.model);
		}
		args.push(opts.prompt);

		return spawnAgent({
			cmd: "claude",
			args,
			cwd: opts.cwd,
			timeoutSeconds: opts.timeoutSeconds,
			logFile: join(process.env.RUNNER_TEMP ?? tmpdir(), "janitor-anthropic.log"),
			env: {
				ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
			},
		});
	},
};
