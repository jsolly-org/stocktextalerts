import { rootLogger } from "../logging";

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

export type GrokSectionResult = {
	content: string;
	citations: string[];
};

const GROK_TIMEOUT_MS = 45_000;

/**
 * Apply xAI annotations to text by converting annotation ranges into inline
 * markdown links. Processes annotations from end to start so character
 * positions remain valid during replacement.
 */
function applyAnnotationsInline(
	text: string,
	annotations: XaiAnnotation[],
): string {
	const valid = annotations
		.filter(
			(a): a is XaiAnnotation & { start_index: number; end_index: number } =>
				typeof a.url === "string" &&
				a.url.trim() !== "" &&
				typeof a.start_index === "number" &&
				typeof a.end_index === "number" &&
				a.start_index >= 0 &&
				a.end_index > a.start_index &&
				a.end_index <= text.length,
		)
		// Sort descending by start_index so replacements don't shift earlier positions.
		.sort((a, b) => b.start_index - a.start_index);

	let result = text;
	for (const ann of valid) {
		const span = result.slice(ann.start_index, ann.end_index);
		// Skip if this span is already part of a markdown link (followed by `(http`).
		const after = result.slice(ann.end_index, ann.end_index + 6);
		if (after.startsWith("(http")) continue;

		// Clean up the link text — remove surrounding brackets and post:N markers.
		let linkText = span.replace(/^\[|\]$/g, "").trim();
		if (!linkText || /^post:\d+$/i.test(linkText)) {
			linkText = "source";
		}

		const markdownLink = `[${linkText}](${ann.url})`;
		result =
			result.slice(0, ann.start_index) +
			markdownLink +
			result.slice(ann.end_index);
	}
	return result;
}

/**
 * Extract plain text and source URLs from an xAI Responses API payload.
 *
 * Annotations with positional data are applied inline as markdown links so
 * that sources appear next to the claims they support. Any remaining
 * annotation URLs (without positions) are returned separately in `citations`.
 */
function extractTextAndCitationsFromXaiResponse(response: ResponsesResponse): {
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
		texts.push(annotated);

		// Collect any annotation URLs that lack position data as fallback citations.
		if (Array.isArray(annotations)) {
			for (const a of annotations as XaiAnnotation[]) {
				if (!a || typeof a !== "object") continue;
				const url = typeof a.url === "string" ? a.url.trim() : "";
				if (url === "") continue;
				// Only collect URLs that weren't applied inline (no position data).
				if (
					typeof a.start_index === "number" &&
					typeof a.end_index === "number"
				) {
					continue;
				}
				citationUrls.add(url);
			}
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
				addText(part.text, part.annotations);
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
						if (type === "output_text" || type === "text")
							addText(text, annotations);
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

/** Build the system/user prompt for the news section. */
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
		"Include inline source links (markdown format) to the original articles.";

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
		"- Include inline links to the source articles in markdown format.\n" +
		"- Output the bullets directly — no wrappers, tags, or preamble.";

	return { system, user };
}

/** Build the system/user prompt for the rumors section. */
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
		"Include inline source links (markdown format) to the original X/social media posts.";

	const bulletCount = Math.min(options.tickers.length, 10);
	const user =
		`Write a short rumors summary for these tickers: ${tickers}.\n` +
		`Local date: ${options.localDateIso} (${options.timezone}).\n` +
		"\nRules:\n" +
		`- One bullet per ticker, up to ${bulletCount}. Skip tickers with nothing noteworthy.\n` +
		"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
		"- Cite X/social media posts where possible with inline markdown links.\n" +
		"- End with: 'Unverified chatter — double-check before acting.'\n" +
		"- Output the bullets directly — no wrappers, tags, or preamble.";

	return { system, user };
}

/**
 * Shared Grok API call with retry logic.
 *
 * Returns `GrokSectionResult` on success, `null` on failure after retries.
 */
async function callGrokApi(options: {
	requestBody: ResponsesRequest;
	logContext: Record<string, unknown>;
}): Promise<GrokSectionResult | null> {
	const metaEnv = getMetaEnv();
	const apiKey = metaEnv?.XAI_API_KEY ?? process.env.XAI_API_KEY;
	if (!apiKey || apiKey.trim() === "") {
		rootLogger.info("Skipping Grok call: XAI_API_KEY is not set", {
			...options.logContext,
			reason: "missing_api_key",
		});
		return null;
	}

	const MAX_RETRIES = 3;

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
				body: JSON.stringify(options.requestBody),
				signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
			});

			if (!response.ok) {
				log("Grok request failed", {
					...options.logContext,
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
				log("Grok returned empty content", {
					...options.logContext,
					attempt,
				});
				if (!isLastAttempt) {
					await delay(attempt);
					continue;
				}
				return null;
			}

			return { content: text, citations };
		} catch (error) {
			const reason =
				error instanceof Error && error.name === "TimeoutError"
					? "timeout"
					: "request_failed";
			log(
				"Grok request errored",
				{ ...options.logContext, attempt, reason },
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

	const model = "grok-4-1-fast-non-reasoning";
	const { system, user } = buildNewsPrompt(options);

	return callGrokApi({
		requestBody: {
			model,
			instructions: system,
			input: user,
			temperature: 0.4,
			max_tokens: 800,
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

	const model = "grok-4-1-fast-non-reasoning";
	const { system, user } = buildRumorsPrompt(options);

	return callGrokApi({
		requestBody: {
			model,
			instructions: system,
			input: user,
			temperature: 0.4,
			max_tokens: 800,
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
