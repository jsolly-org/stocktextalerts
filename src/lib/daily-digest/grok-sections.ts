import { rootLogger } from "../logging";
import {
	collectMessageAnnotations,
	fetchGrokResponse,
	type GrokResponsesRequest,
	type GrokTextFormat,
	parseResponsesJsonObject,
} from "../vendors/grok";
import { applyAnnotationsInline } from "../vendors/grok-citations";
import { GROK_DIGEST_MODEL } from "../vendors/grok-models";

export type GrokSectionResult = {
	content: string;
	citations: string[];
};

export const GROK_DIGEST_TEXT_FORMAT = {
	type: "json_schema",
	name: "digest_section",
	strict: true,
	schema: {
		type: "object",
		properties: {
			markdown: { type: "string" },
		},
		required: ["markdown"],
		additionalProperties: false,
	},
} as const satisfies GrokTextFormat;

function stripBold(markdown: string): string {
	return markdown.replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

function buildNewsPrompt(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	providerNewsContext?: string;
}): { system: string; user: string } {
	const tickers = options.tickers.join(", ");

	const system =
		"You write factual financial news summaries for daily email digests. " +
		"Be descriptive, neutral, and cautious. " +
		"Do not give buy/sell advice. " +
		"Cite every claim with a markdown source link `[Source](https://...)` using the " +
		"publication's short name as link text (e.g. `[CNBC](url)`, `[Reuters](url)`, `[Bloomberg](url)`). " +
		"Use real URLs from your search results — do not invent URLs. " +
		"Plain text otherwise — no markdown formatting beyond citation links " +
		"(no **bold**, no *italic*, no headings, no bullets like `-` or `*`). " +
		"Return the section body via the structured response schema markdown field.";

	const newsContextBlock = options.providerNewsContext
		? `\nHere are recent headlines for context (use these as your primary source):\n${options.providerNewsContext}\n`
		: "";

	const bulletCount = Math.min(options.tickers.length, 10);
	const user =
		`Write a short news summary for these tickers: ${tickers}.\n` +
		`Local date: ${options.localDateIso} (${options.timezone}).\n` +
		newsContextBlock +
		"\nRules:\n" +
		`- One bullet per ticker, up to ${bulletCount}. Skip tickers with nothing noteworthy.\n` +
		"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
		"- Each bullet must include at least one source citation as `[Source](https://...)` using a real URL from search results.\n" +
		"- Put the bullets in the structured markdown field — no wrappers, tags, or preamble outside that field.\n" +
		"\nExample markdown field content:\n" +
		"AAPL: Apple shares fell 3% after the FTC opened an inquiry into App Store practices, adding to concerns over slowing services revenue [CNBC](https://www.cnbc.com/2026/02/14/apple-ftc-inquiry.html).\n" +
		"NVDA: Nvidia declined 2% as competition from AMD accelerators intensified ahead of next week's earnings report [Bloomberg](https://www.bloomberg.com/news/articles/2026-02-14/nvda-amd-competition).";

	return { system, user };
}

function buildRumorsPrompt(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
}): { system: string; user: string } {
	const tickers = options.tickers.join(", ");

	const system =
		"You summarize social media chatter and unverified rumors about stocks. " +
		"Use hedge words like 'chatter', 'unconfirmed', and 'reportedly'. " +
		"Do not give buy/sell advice. " +
		"Attribute every claim to a specific X poster using a markdown link with the @handle as link text: " +
		"`[@handle](https://x.com/handle/status/POST_ID)` — use the poster's real handle and the actual X post URL " +
		"from your search results. Do NOT use anonymous `/i/status/` URLs and do not invent URLs. " +
		"Plain text otherwise — no markdown formatting beyond citation links " +
		"(no **bold**, no *italic*, no headings, no bullets like `-` or `*`). " +
		"Return the section body via the structured response schema markdown field.";

	const bulletCount = Math.min(options.tickers.length, 10);
	const user =
		`Write a short rumors summary for these tickers: ${tickers}.\n` +
		`Local date: ${options.localDateIso} (${options.timezone}).\n` +
		"\nRules:\n" +
		`- One bullet per ticker, up to ${bulletCount}. Skip tickers with nothing noteworthy.\n` +
		"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
		"- Every @handle attribution must be a markdown link to the actual X post: `[@handle](https://x.com/handle/status/POST_ID)`.\n" +
		"- Use real handles and post URLs from your search results — do not invent them, and do not use anonymous `/i/status/` URLs.\n" +
		"- Put the bullets in the structured markdown field — no wrappers, tags, or preamble outside that field.\n" +
		"\nExample markdown field content:\n" +
		"AAPL: Chatter about Siri delays pressuring shares, with [@TechBullish](https://x.com/TechBullish/status/1758000000000000001) flagging supply chain friction and [@MarketWatcher](https://x.com/MarketWatcher/status/1758000000000000002) noting strong China sales as an offset.\n" +
		"NVDA: [@ChipAnalyst](https://x.com/ChipAnalyst/status/1758000000000000003) reports UBS raising PT to $245 ahead of earnings, while [@OptionsFlow](https://x.com/OptionsFlow/status/1758000000000000004) highlights aggressive upside bets.";

	return { system, user };
}

async function callGrokSectionApi(options: {
	requestBody: GrokResponsesRequest;
	logContext: Record<string, unknown>;
}): Promise<GrokSectionResult | null> {
	const data = await fetchGrokResponse(options);
	if (!data) {
		return null;
	}

	const obj = parseResponsesJsonObject(data);
	const rawMarkdown = obj && typeof obj.markdown === "string" ? obj.markdown.trim() : "";
	if (!rawMarkdown) {
		rootLogger.error("Grok digest section JSON/markdown missing; omit section", {
			...options.logContext,
			category: "vendor_retry_exhausted",
		});
		return null;
	}

	const annotated = applyAnnotationsInline(rawMarkdown, collectMessageAnnotations(data));
	return { content: stripBold(annotated), citations: [] };
}

/**
 * Generate a news section using Grok with web_search.
 *
 * Returns `null` when tickers are empty, the API key is missing, or the request fails.
 */
export async function generateNewsWithGrok(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	providerNewsContext?: string;
	requestId?: string;
}): Promise<GrokSectionResult | null> {
	if (options.tickers.length === 0) return null;

	const model = GROK_DIGEST_MODEL;
	const { system, user } = buildNewsPrompt(options);

	return callGrokSectionApi({
		requestBody: {
			model,
			instructions: system,
			input: user,
			temperature: 0.4,
			max_output_tokens: 800,
			reasoning_effort: "none",
			tools: [{ type: "web_search" }],
			text: { format: GROK_DIGEST_TEXT_FORMAT },
		},
		logContext: {
			action: "grok_news",
			model,
			tickersCount: options.tickers.length,
			requestId: options.requestId,
		},
	});
}

/**
 * Generate a rumors section using Grok with x_search.
 *
 * Returns `null` when tickers are empty, the API key is missing, or the request fails.
 */
export async function generateRumorsWithGrok(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	requestId?: string;
}): Promise<GrokSectionResult | null> {
	if (options.tickers.length === 0) return null;

	const model = GROK_DIGEST_MODEL;
	const { system, user } = buildRumorsPrompt(options);

	return callGrokSectionApi({
		requestBody: {
			model,
			instructions: system,
			input: user,
			temperature: 0.4,
			max_output_tokens: 800,
			reasoning_effort: "none",
			tools: [{ type: "x_search" }],
			text: { format: GROK_DIGEST_TEXT_FORMAT },
		},
		logContext: {
			action: "grok_rumors",
			model,
			tickersCount: options.tickers.length,
			requestId: options.requestId,
		},
	});
}
