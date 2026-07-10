/**
 * OpenAI (Codex) agent provider.
 *
 * Installs `@openai/codex` and runs `codex exec` non-interactively.
 * Auth: `CODEX_API_KEY` (preferred) or `OPENAI_API_KEY`.
 *
 * Swap in via `JANITOR_PROVIDER=openai` once the secret is set.
 * Docs: https://developers.openai.com/codex/noninteractive
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentProvider, AgentRunOptions, AgentRunResult } from "../types";
import { ensureAgentBinsOnPath, spawnAgent, which } from "../spawn";

function resolveApiKeyEnv(): { name: string; value: string } {
	const codex = process.env.CODEX_API_KEY?.trim();
	if (codex) return { name: "CODEX_API_KEY", value: codex };
	const openai = process.env.OPENAI_API_KEY?.trim();
	if (openai) return { name: "OPENAI_API_KEY", value: openai };
	throw new Error(
		"Missing CODEX_API_KEY or OPENAI_API_KEY for the openai provider",
	);
}

async function installCodex(): Promise<void> {
	ensureAgentBinsOnPath();
	if (await which("codex")) return;

	await new Promise<void>((resolve, reject) => {
		const child = spawn("npm", ["install", "-g", "@openai/codex"], {
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`codex install failed (exit ${code})`));
		});
	});

	ensureAgentBinsOnPath();
}

export const openaiProvider: AgentProvider = {
	id: "openai",
	// Documented primary; run() also accepts OPENAI_API_KEY.
	apiKeyEnv: "CODEX_API_KEY",

	async ensureInstalled() {
		resolveApiKeyEnv();
		await installCodex();
		if (!(await which("codex"))) {
			throw new Error("codex CLI not found on PATH after install");
		}
	},

	async run(opts: AgentRunOptions): Promise<AgentRunResult> {
		const key = resolveApiKeyEnv();
		const args = [
			"exec",
			// Full-auto: allow edits + network for gh/changelog fetches in CI.
			"--full-auto",
		];
		if (opts.model) {
			args.push("--model", opts.model);
		}
		args.push(opts.prompt);

		return spawnAgent({
			cmd: "codex",
			args,
			cwd: opts.cwd,
			timeoutSeconds: opts.timeoutSeconds,
			logFile: join(process.env.RUNNER_TEMP ?? tmpdir(), "janitor-openai.log"),
			env: {
				[key.name]: key.value,
			},
		});
	},
};
