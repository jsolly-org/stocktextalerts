import type { AgentProvider, AgentProviderId } from "../types";
import { AGENT_PROVIDER_IDS } from "../types";
import { anthropicProvider } from "./anthropic";
import { cursorProvider } from "./cursor";
import { openaiProvider } from "./openai";

const PROVIDERS: Record<AgentProviderId, AgentProvider> = {
	cursor: cursorProvider,
	anthropic: anthropicProvider,
	openai: openaiProvider,
};

export function parseProviderId(raw: string | undefined): AgentProviderId {
	const id = (raw?.trim().toLowerCase() || "cursor") as AgentProviderId;
	if (!AGENT_PROVIDER_IDS.includes(id)) {
		throw new Error(
			`Unknown JANITOR_PROVIDER=${JSON.stringify(raw)}. Expected one of: ${AGENT_PROVIDER_IDS.join(", ")}`,
		);
	}
	return id;
}

export function getProvider(id: AgentProviderId): AgentProvider {
	return PROVIDERS[id];
}
