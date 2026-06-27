import { applyAnnotationsInline, type XaiAnnotation } from "../ai/grok-citations";
import { rootLogger } from "../logging";
import {
	fetchGrokResponse,
	type GrokResponsesRequest,
	type GrokResponsesResponse,
} from "../vendors/grok";

export type GrokSectionResult = {
	content: string;
	citations: string[];
};

type XaiOutputContentPart =
	| {
			type: "output_text" | "text";
			text: string;
			annotations?: XaiAnnotation[] | undefined;
			logprobs?: unknown;
	  }
	| {
			type: string;
			[key: string]: unknown;
	  };

type XaiOutputItem =
	| {
			id?: string;
			type: "message";
			role?: "assistant" | "system" | "user" | (string & {});
			status?: string;
			content?: XaiOutputContentPart[] | undefined;
	  }
	| {
			id?: string;
			type: "reasoning";
			status?: string;
			summary?: Array<{ type?: string; text?: string }> | undefined;
	  }
	| {
			id?: string;
			type?: string;
			[key: string]: unknown;
	  };

/**
 * Extract plain text and source URLs from an xAI Responses API payload.
 *
 * Annotations with positional data are applied inline as markdown links so
 * that sources appear next to the claims they support. Any remaining
 * annotation URLs (without positions) are returned separately in `citations`.
 */
function extractTextAndCitationsFromXaiResponse(response: GrokResponsesResponse): {
	text: string | null;
	citations: string[];
} {
	const texts: string[] = [];
	const citationUrls = new Set<string>();

	const addText = (value: unknown, annotations?: unknown) => {
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		if (trimmed === "") return;

		// Apply positional annotations inline as markdown links.
		const annotated = Array.isArray(annotations)
			? applyAnnotationsInline(trimmed, annotations as XaiAnnotation[])
			: trimmed;
		// Strip stray markdown bold markers — the email renderer owns ticker
		// bolding, and non-reasoning Grok models tend to wrap whole bullets in
		// `**...**` which would turn entire News/Rumors lines bold downstream.
		const stripped = annotated.replace(/\*\*([^*\n]+)\*\*/g, "$1");
		texts.push(stripped);

		// Collect any annotation URLs that lack position data as fallback citations.
		if (Array.isArray(annotations)) {
			for (const a of annotations as XaiAnnotation[]) {
				if (!a || typeof a !== "object") continue;
				const url = typeof a.url === "string" ? a.url.trim() : "";
				if (url === "") continue;
				// Only collect URLs that weren't applied inline (no position data).
				if (typeof a.start_index === "number" && typeof a.end_index === "number") {
					continue;
				}
				citationUrls.add(url);
			}
		}
	};

	const output = Array.isArray(response.output) ? response.output : [];
	for (const item of output as XaiOutputItem[]) {
		if (!item || typeof item !== "object") continue;

		if (item.type === "message") {
			const content = item.content;
			if (!Array.isArray(content)) continue;

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if (part.type !== "output_text" && part.type !== "text") continue;
				addText(part.text, part.annotations);
			}
			continue;
		}

		if ("message" in item) {
			const message = (item as { message?: unknown }).message;
			if (message && typeof message === "object") {
				const content = (message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const part of content) {
						if (!part || typeof part !== "object") continue;
						const type = (part as { type?: unknown }).type;
						const text = (part as { text?: unknown }).text;
						const annotations = (part as { annotations?: unknown }).annotations;
						if (type === "output_text" || type === "text") addText(text, annotations);
					}
				}
			}
		}
	}

	const text = texts.join("\n").trim();
	return { text: text === "" ? null : text, citations: [...citationUrls] };
}

function buildNewsPrompt(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	finnhubNewsContext?: string;
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
		"(no **bold**, no *italic*, no headings, no bullets like `-` or `*`).";

	const newsContextBlock = options.finnhubNewsContext
		? `\nHere are recent headlines for context (use these as your primary source):\n${options.finnhubNewsContext}\n`
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
		"- Output the bullets directly — no wrappers, tags, or preamble.\n" +
		"\nExample output:\n" +
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
		"(no **bold**, no *italic*, no headings, no bullets like `-` or `*`).";

	const bulletCount = Math.min(options.tickers.length, 10);
	const user =
		`Write a short rumors summary for these tickers: ${tickers}.\n` +
		`Local date: ${options.localDateIso} (${options.timezone}).\n` +
		"\nRules:\n" +
		`- One bullet per ticker, up to ${bulletCount}. Skip tickers with nothing noteworthy.\n` +
		"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
		"- Every @handle attribution must be a markdown link to the actual X post: `[@handle](https://x.com/handle/status/POST_ID)`.\n" +
		"- Use real handles and post URLs from your search results — do not invent them, and do not use anonymous `/i/status/` URLs.\n" +
		"- Output the bullets directly — no wrappers, tags, or preamble.\n" +
		"\nExample output:\n" +
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

	const { text, citations } = extractTextAndCitationsFromXaiResponse(data);
	if (!text) {
		rootLogger.error("Grok returned empty content", {
			...options.logContext,
			category: "vendor_retry_exhausted",
		});
		return null;
	}

	return { content: text, citations };
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
	finnhubNewsContext?: string;
	requestId?: string;
}): Promise<GrokSectionResult | null> {
	if (options.tickers.length === 0) return null;

	const model = "grok-4.20-non-reasoning";
	const { system, user } = buildNewsPrompt(options);

	return callGrokSectionApi({
		requestBody: {
			model,
			instructions: system,
			input: user,
			temperature: 0.4,
			max_output_tokens: 800,
			tools: [{ type: "web_search" }],
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

	const model = "grok-4.20-non-reasoning";
	const { system, user } = buildRumorsPrompt(options);

	return callGrokSectionApi({
		requestBody: {
			model,
			instructions: system,
			input: user,
			temperature: 0.4,
			max_output_tokens: 800,
			tools: [{ type: "x_search" }],
		},
		logContext: {
			action: "grok_rumors",
			model,
			tickersCount: options.tickers.length,
			requestId: options.requestId,
		},
	});
}
