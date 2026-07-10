/**
 * Provider-agnostic agent runner contract for the scheduled janitor.
 *
 * Swap backends via `JANITOR_PROVIDER` (`cursor` | `anthropic` | `openai`).
 * The prompt and merge envelope live outside the provider — only the CLI
 * install + invoke differ.
 */

export const AGENT_PROVIDER_IDS = ["cursor", "anthropic", "openai"] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

export type AgentRunOptions = {
	/** Full janitor task prompt (already loaded from prompt.md). */
	prompt: string;
	/** Repo root the agent should treat as cwd. */
	cwd: string;
	/** Optional model override (provider-specific id). */
	model: string | undefined;
	/** Soft wall-clock limit for the agent process (seconds). */
	timeoutSeconds: number;
};

export type AgentRunResult = {
	exitCode: number;
	/** Short text for the Actions job summary (stdout/stderr tail). */
	summary: string;
};

export type AgentProvider = {
	readonly id: AgentProviderId;
	/** Env var that must be present before `run`. */
	readonly apiKeyEnv: string;
	/** Install / locate the CLI. Idempotent. */
	ensureInstalled: () => Promise<void>;
	/** Run one headless agent pass. */
	run: (opts: AgentRunOptions) => Promise<AgentRunResult>;
};
