import { rootLogger } from "./logging";

const BASE_RETRY_DELAY_MS = 1_000;
/**
 * Exponential backoff helper for Grok retries.
 *
 * Uses `BASE_RETRY_DELAY_MS * 2^(attempt-1)` with `setTimeout`.
 */
const delay = (attempt: number) =>
	new Promise<void>((r) =>
		setTimeout(r, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)),
	);

type ResponsesRequest = {
	model: string;
	input: string;
	instructions: string;
	temperature?: number;
	max_tokens?: number;
	tools?: Array<{ type: "web_search" | "x_search" }>;
	include?: string[];
};

// xAI Responses API (OpenAPI `ModelResponse`)
type XaiAnnotation = {
	type: string;
	url: string;
	start_index?: number | null;
	end_index?: number | null;
};

type XaiOutputContentPart =
	| {
			type: "output_text" | "text";
			text: string;
			annotations?: XaiAnnotation[] | undefined;
			logprobs?: unknown;
	  }
	| {
			// Future / unknown content part types.
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
			// e.g. reasoning items can contain `summary` instead of `content`
			id?: string;
			type: "reasoning";
			status?: string;
			summary?: Array<{ type?: string; text?: string }> | undefined;
	  }
	| {
			// Unknown output item type.
			id?: string;
			type?: string;
			[key: string]: unknown;
	  };

type ResponsesResponse = {
	id: string;
	object: "response" | (string & {});
	created_at: number;
	model: string;
	status: string;
	output: XaiOutputItem[];
};

export type GrokExtrasResult = {
	news: string | null;
	rumors: string | null;
	citations: string[];
};

const GROK_TIMEOUT_MS = 30_000;

/**
 * Extract plain text and source URLs from an xAI Responses API payload.
 *
 * This intentionally only pulls assistant-visible output text and annotation URLs, and
 * avoids attempting to interpret non-text output items.
 */
function extractTextAndCitationsFromXaiResponse(response: ResponsesResponse): {
	text: string | null;
	citations: string[];
} {
	const texts: string[] = [];
	const citationUrls = new Set<string>();

	const addText = (value: unknown) => {
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		if (trimmed !== "") texts.push(trimmed);
	};

	const addAnnotationCitations = (value: unknown) => {
		if (!Array.isArray(value)) return;
		for (const a of value) {
			if (!a || typeof a !== "object") continue;
			const url = (a as { url?: unknown }).url;
			if (typeof url !== "string") continue;
			const trimmed = url.trim();
			if (trimmed !== "") citationUrls.add(trimmed);
		}
	};

	// Per OpenAPI, assistant text is typically in:
	// response.output[].type === "message" -> content[].type === "output_text" -> text
	const output = Array.isArray((response as { output?: unknown }).output)
		? ((response as { output: XaiOutputItem[] }).output ?? [])
		: [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;

		if (item.type === "message") {
			const content = item.content;
			if (!Array.isArray(content)) continue;

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if (part.type !== "output_text" && part.type !== "text") continue;
				addText(part.text);
				addAnnotationCitations(part.annotations);
			}
			continue;
		}

		// Fallback for unexpected/legacy shapes: pull any obvious text/urls.
		// (kept intentionally conservative to avoid leaking reasoning summaries)
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
						if (type === "output_text" || type === "text") addText(text);
						addAnnotationCitations(annotations);
					}
				}
			}
		}
	}

	const text = texts.join("\n").trim();
	return { text: text === "" ? null : text, citations: [...citationUrls] };
}

/** Read Vite `import.meta.env` in a way that also works in Node contexts. */
function getMetaEnv(): Record<string, string | undefined> | undefined {
	return (import.meta as { env?: Record<string, string | undefined> }).env;
}

/**
 * Build the system/user prompt used to request "extras" content from Grok.
 *
 * The prompt enforces a strict tagged format so we can reliably parse the response.
 */
function buildExtrasPrompt(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	includeNews: boolean;
	includeRumors: boolean;
	finnhubNewsContext?: string;
}): { system: string; user: string } {
	const tickers = options.tickers.join(", ");
	const requested = [
		options.includeNews ? "news" : null,
		options.includeRumors ? "rumors" : null,
	]
		.filter(Boolean)
		.join(" + ");

	const system =
		"You write detailed email extras for asset alerts. Use complete sentences. " +
		"Be descriptive, neutral, and cautious. " +
		"Do not give buy/sell advice. " +
		"Do not claim to have real-time data or verified facts. " +
		"Include inline source links where available to support your claims.";

	const newsContextBlock = options.finnhubNewsContext
		? `\nHere are recent headlines for context (use these as your primary source for the news section):\n${options.finnhubNewsContext}\n`
		: "";

	return {
		system,
		user:
			`Write short ${requested || "extras"} content for these tickers: ${tickers}.\n` +
			`Context: this will be sent as part of the daily digest.\n` +
			`Local date: ${options.localDateIso} (${options.timezone}).\n` +
			newsContextBlock +
			"\nReturn EXACTLY this tagged format (no extra text outside tags):\n" +
			"[NEWS]\n" +
			"<content>\n" +
			"[/NEWS]\n" +
			"[RUMORS]\n" +
			"<content>\n" +
			"[/RUMORS]\n\n" +
			"Rules:\n" +
			"- If news is not requested, output nothing between [NEWS] and [/NEWS].\n" +
			"- If rumors are not requested, output nothing between [RUMORS] and [/RUMORS].\n" +
			"- Each requested section: 3–7 bullet points max.\n" +
			"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
			"- Include source links inline (markdown format) when referencing specific news or posts.\n" +
			"- Keep each section under 1500 characters.\n" +
			"- News: cite your sources with inline links to articles.\n" +
			"- Rumors: cite X/social media posts where possible. Use hedge words like 'chatter' and 'unconfirmed'. End the section with: 'Unverified chatter — double-check before acting.'",
	};
}

/**
 * Extract the content between `[TAG]` and `[/TAG]` markers.
 *
 * Returns `null` when tags are missing, malformed, or the content is empty.
 */
function extractTaggedBlock(
	text: string,
	tag: "NEWS" | "RUMORS",
): string | null {
	const start = `[${tag}]`;
	const end = `[/${tag}]`;
	const startIndex = text.indexOf(start);
	const endIndex = text.indexOf(end);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		return null;
	}

	const content = text.slice(startIndex + start.length, endIndex).trim();
	return content === "" ? null : content;
}

/**
 * Generate optional daily "extras" (news/rumors) using Grok for email delivery.
 *
 * Returns `null` when no extras are requested, tickers are empty, the API key is missing,
 * or the request ultimately fails after retries.
 */
export async function generateDailyExtrasWithGrok(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	includeNews: boolean;
	includeRumors: boolean;
	requestId?: string;
	finnhubNewsContext?: string;
}): Promise<GrokExtrasResult | null> {
	if (options.tickers.length === 0) {
		return null;
	}
	if (!options.includeNews && !options.includeRumors) {
		return null;
	}

	const metaEnv = getMetaEnv();
	const apiKey = metaEnv?.XAI_API_KEY ?? process.env.XAI_API_KEY;
	if (!apiKey || apiKey.trim() === "") {
		rootLogger.info("Skipping Grok extras: XAI_API_KEY is not set", {
			action: "grok_extras",
			reason: "missing_api_key",
			tickersCount: options.tickers.length,
			includeNews: options.includeNews,
			includeRumors: options.includeRumors,
			requestId: options.requestId,
		});
		return null;
	}

	const model =
		metaEnv?.XAI_GROK_MODEL ??
		process.env.XAI_GROK_MODEL ??
		"grok-4-1-fast-reasoning";
	const { system, user } = buildExtrasPrompt(options);

	const requestBody: ResponsesRequest = {
		model,
		instructions: system,
		input: user,
		temperature: 0.4,
		max_tokens: 1200,
		tools: [{ type: "web_search" }, { type: "x_search" }],
	};

	const MAX_RETRIES = 3;
	const logContext = {
		action: "grok_extras",
		model,
		tickersCount: options.tickers.length,
		includeNews: options.includeNews,
		includeRumors: options.includeRumors,
		requestId: options.requestId,
	};

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		const log = isLastAttempt
			? rootLogger.error.bind(rootLogger)
			: rootLogger.warn.bind(rootLogger);

		try {
			const response = await fetch("https://api.x.ai/v1/responses", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
				signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
			});

			if (!response.ok) {
				log("Grok extras request failed", {
					...logContext,
					attempt,
					status: response.status,
					statusText: response.statusText,
				});
				if (!isLastAttempt) {
					await delay(attempt);
					continue;
				}
				return null;
			}

			const data = (await response.json()) as ResponsesResponse;
			const { text, citations } = extractTextAndCitationsFromXaiResponse(data);
			if (!text) {
				log("Grok extras returned empty content", {
					...logContext,
					attempt,
				});
				if (!isLastAttempt) {
					await delay(attempt);
					continue;
				}
				return null;
			}

			const news = options.includeNews
				? extractTaggedBlock(text, "NEWS")
				: null;
			const rumors = options.includeRumors
				? extractTaggedBlock(text, "RUMORS")
				: null;

			if (!news && !rumors) {
				log("Grok extras missing expected tags/content", {
					...logContext,
					attempt,
				});
				if (!isLastAttempt) {
					await delay(attempt);
					continue;
				}
				return null;
			}

			return { news, rumors, citations };
		} catch (error) {
			const reason =
				error instanceof Error && error.name === "TimeoutError"
					? "timeout"
					: "request_failed";
			log(
				"Grok extras request errored",
				{ ...logContext, attempt, reason },
				error,
			);
			if (!isLastAttempt) {
				await delay(attempt);
				continue;
			}
			return null;
		}
	}

	return null;
}
