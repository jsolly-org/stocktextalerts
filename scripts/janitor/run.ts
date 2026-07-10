/**
 * Scheduled janitor entrypoint.
 *
 * Loads the provider-agnostic prompt, selects a backend via JANITOR_PROVIDER
 * (default: cursor), runs one `/janitor once`-equivalent pass, and writes a
 * short summary to $GITHUB_STEP_SUMMARY when present.
 *
 * Usage:
 *   JANITOR_PROVIDER=cursor CURSOR_API_KEY=… npm run janitor
 *   JANITOR_PROVIDER=anthropic ANTHROPIC_API_KEY=… npm run janitor
 *   JANITOR_PROVIDER=openai CODEX_API_KEY=… npm run janitor
 */

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, parseProviderId } from "./providers/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const PROMPT_PATH = join(HERE, "prompt.md");

const DEFAULT_TIMEOUT_SECONDS = 45 * 60;

function readTimeoutSeconds(): number {
	const raw = process.env.JANITOR_TIMEOUT_SECONDS?.trim();
	if (!raw) return DEFAULT_TIMEOUT_SECONDS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 60) {
		throw new Error(
			`JANITOR_TIMEOUT_SECONDS must be a number >= 60 (got ${JSON.stringify(raw)})`,
		);
	}
	return Math.floor(n);
}

function writeStepSummary(title: string, body: string): void {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (!path) return;
	// Body is already redacted by spawnAgent; keep the summary short.
	const clipped =
		body.length > 4_000 ? `…(truncated)\n${body.slice(-4_000)}` : body;
	appendFileSync(path, `## ${title}\n\n\`\`\`\n${clipped}\n\`\`\`\n`);
}

async function main(): Promise<void> {
	const providerId = parseProviderId(process.env.JANITOR_PROVIDER);
	const provider = getProvider(providerId);
	const model = process.env.JANITOR_MODEL?.trim() || undefined;
	const timeoutSeconds = readTimeoutSeconds();
	const prompt = readFileSync(PROMPT_PATH, "utf8");

	const repo = process.env.GITHUB_REPOSITORY ?? "(local)";
	process.stderr.write(
		`janitor: provider=${providerId} repo=${repo} timeout=${timeoutSeconds}s model=${model ?? "(default)"}\n`,
	);

	await provider.ensureInstalled();
	const result = await provider.run({
		prompt,
		cwd: ROOT,
		model,
		timeoutSeconds,
	});

	writeStepSummary(
		`Janitor (${providerId}) — exit ${result.exitCode}`,
		result.summary,
	);
	process.stderr.write(result.summary);
	if (!result.summary.endsWith("\n")) process.stderr.write("\n");

	if (result.exitCode !== 0) {
		process.exitCode = result.exitCode;
	}
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.stack ?? err.message : String(err);
	process.stderr.write(`janitor failed: ${message}\n`);
	writeStepSummary("Janitor failed", message);
	process.exitCode = 1;
});
