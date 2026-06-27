import { setTimeout as realDelay } from "node:timers/promises";
import { readEnv } from "../db/env";
import { rootLogger } from "../logging";

const BASE_RETRY_DELAY_MS = 1_000;
/**
 * Exponential backoff helper for Grok retries.
 *
 * Uses `node:timers/promises` so delays work even when vitest's
 * `vi.useFakeTimers()` has replaced the global `setTimeout`.
 */
const delay = (attempt: number) => realDelay(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));

type ResponsesRequest = {
	model: string;
	input: string;
	instructions: string;
	temperature?: number;
	max_output_tokens?: number;
	tools?: Array<{ type: "web_search" | "x_search" }>;
	include?: string[];
};

// xAI Responses API (OpenAPI `ModelResponse`)
export type XaiAnnotation = {
	type: string;
	url: string;
	title?: string;
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

/**
 * Per-attempt timeouts for Grok API calls (escalating).
 *
 * Total worst-case across all attempts (including backoff delays):
 * 30s + 1s + 45s + 2s + 60s = 138s.
 */
const GROK_TIMEOUT_BY_ATTEMPT_MS = [30_000, 45_000, 60_000] as const;

/** Well-known domains → short display names for news citation links. */
const DOMAIN_LABELS: Record<string, string> = {
	"cnbc.com": "CNBC",
	"finance.yahoo.com": "Yahoo Finance",
	"yahoo.com": "Yahoo",
	"investopedia.com": "Investopedia",
	"seekingalpha.com": "Seeking Alpha",
	"morningstar.com": "Morningstar",
	"marketwatch.com": "MarketWatch",
	"bloomberg.com": "Bloomberg",
	"reuters.com": "Reuters",
	"wsj.com": "WSJ",
	"barrons.com": "Barron's",
	"fool.com": "Motley Fool",
	"marketbeat.com": "MarketBeat",
	"benzinga.com": "Benzinga",
	"thestreet.com": "TheStreet",
	"tradingview.com": "TradingView",
	"trefis.com": "Trefis",
	"electrek.co": "Electrek",
	"techcrunch.com": "TechCrunch",
	"theverge.com": "The Verge",
	"arstechnica.com": "Ars Technica",
};

/** Determine whether a URL is from X/Twitter. */
export function isXUrl(url: string): boolean {
	return /^https?:\/\/(?:x|twitter)\.com\//.test(url);
}

/**
 * Derive a human-readable link label from a URL.
 *
 * - X/Twitter posts → `@handle` (or null for anonymous `/i/` links)
 * - Known news domains → friendly name (e.g. "CNBC")
 * - Other URLs → bare domain (e.g. "example.com")
 */
export function linkLabelFromUrl(url: string): string | null {
	// X/Twitter posts: show @handle
	const xMatch = url.match(/^https?:\/\/(?:x|twitter)\.com\/([^/]+)\/status\/\d+/);
	if (xMatch) {
		const handle = xMatch[1];
		return handle === "i" ? null : `@${handle}`;
	}

	// Extract hostname and check known domains
	try {
		const hostname = new URL(url).hostname.replace(/^www\./, "");
		// Check exact match first, then parent domain (e.g. "finance.yahoo.com" → "yahoo.com")
		if (DOMAIN_LABELS[hostname]) return DOMAIN_LABELS[hostname];
		const parts = hostname.split(".");
		if (parts.length > 2) {
			const parent = parts.slice(-2).join(".");
			if (DOMAIN_LABELS[parent]) return DOMAIN_LABELS[parent];
		}
		return hostname;
	} catch {
		return null;
	}
}

/**
 * Apply xAI annotations to text by converting annotation ranges into inline
 * markdown links. Processes annotations from end to start so character
 * positions remain valid during replacement.
 */
export function applyAnnotationsInline(text: string, annotations: XaiAnnotation[]): string {
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

	// Phase 0: Strip <grok:render> citation tags.
	// Grok web_search sometimes embeds XML-style citation references that use
	// opaque hash-based citation_ids instead of URLs. These can't be resolved
	// to clickable links, so strip them to keep the text clean.
	result = result.replace(/<grok:render[^>]*>[\s\S]*?<\/grok:render>/g, "");

	// Phase 1: Apply positioned annotations as inline markdown links.
	for (const ann of valid) {
		const span = result.slice(ann.start_index, ann.end_index);

		// Skip if this span already contains a markdown link (e.g. `[[1]](url)`).
		// xAI web_search annotations sometimes span the entire markdown link text
		// that Grok already embedded — re-wrapping would duplicate the URL.
		if (/\]\(https?:\/\//.test(span)) continue;

		// Skip if this span is already part of a markdown link.
		// Check for `(http` directly after the span, or `](http` when the span is
		// inside nested brackets like `[[1]](url)` where the annotation covers `[1]`.
		const after = result.slice(ann.end_index, ann.end_index + 10);
		if (/^\]?\(https?:/.test(after)) continue;

		// Clean up the link text — remove surrounding brackets and post:N markers.
		let linkText = span.replace(/^\[|\]$/g, "").trim();
		if (!linkText || /^post:\d+$/i.test(linkText)) {
			linkText = "source";
		}

		const markdownLink = `[${linkText}](${ann.url})`;
		result = result.slice(0, ann.start_index) + markdownLink + result.slice(ann.end_index);
	}

	// Phase 2: Resolve remaining [post:N] / [web:N] markers from search results.
	// Grok outputs [post:N] (x_search) and [web:N] (web_search) where N is the
	// 0-based index into search results. When annotations lack positional data,
	// Phase 1 can't resolve them. Map each marker to annotations[N].url.
	// The outer bracket in `\[?` / `\]?` handles Grok sometimes double-wrapping
	// markers as `[[post:N]]`.
	let linkCounter = 0;
	result = result.replace(/\[?\[(?:post|web):(\d+)\]\]?/g, (_match, numStr) => {
		const idx = parseInt(numStr, 10);
		const ann = annotations[idx];
		if (ann && typeof ann.url === "string" && ann.url.trim() !== "") {
			linkCounter++;
			const url = ann.url.trim();
			const linkText = linkLabelFromUrl(url) ?? `[${linkCounter}]`;
			return `[[${linkText}]](${url})`;
		}
		return "";
	});

	// Phase 3: Shorten URL-as-link-text for X/Twitter posts.
	// Grok sometimes embeds full URLs as link text (e.g. [https://x.com/handle/status/...](url)).
	// Replace with a readable @handle label, or "post" for anonymous /i/ links.
	result = result.replace(
		/\[https?:\/\/(?:x|twitter)\.com\/([^/\]]+)\/status\/[^\]]+\]/g,
		(_, handle) => (handle === "i" ? "[[post]]" : `[[@${handle}]]`),
	);

	// Phase 4: Rewrite numeric citation text (e.g. `[[1]](url)`) to readable labels.
	// Grok's web_search embeds `[[N]](url)` natively — Phase 1 preserves these.
	// Replace the opaque `[N]` text with the source name derived from the URL.
	result = result.replace(/\[\[(\d+)\]\]\((https?:\/\/[^)]+)\)/g, (_match, _num, url) => {
		const label = linkLabelFromUrl(url as string);
		return label ? `[[${label}]](${url})` : _match;
	});

	// Phase 5: Link inline @handle mentions to anonymous x_search citation URLs.
	// Grok's x_search often produces anonymous /i/ URLs that lack the poster's
	// handle. When @handles appear as plain text alongside [[N]](url) citations,
	// pair them positionally and make the @handle the clickable link text.
	// Process per-line so URLs from one ticker bullet don't bleed into another.
	const lines = result.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const original = lines[i];
		if (original === undefined) continue;
		let line = original;
		const anonXUrls: string[] = [];
		for (const m of line.matchAll(
			/\[\[\d+\]\]\((https?:\/\/(?:x|twitter)\.com\/i\/status\/\d+)\)/g,
		)) {
			const [, captured] = m;
			if (captured) anonXUrls.push(captured);
		}
		if (anonXUrls.length > 0) {
			// Remove the [[N]](anonymous-url) citation markers
			line = line.replace(/\[\[\d+\]\]\(https?:\/\/(?:x|twitter)\.com\/i\/status\/\d+\)/g, "");
			// Link unlinked @handle mentions with the anonymous URLs, in order
			let anonIdx = 0;
			line = line.replace(/(?<!\[)@([A-Za-z0-9_]+)/g, (match) => {
				const anonUrl = anonXUrls[anonIdx];
				if (anonUrl !== undefined) {
					anonIdx++;
					return `[[${match}]](${anonUrl})`;
				}
				return match;
			});
		}
		lines[i] = line;
	}
	result = lines.join("\n");

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

/**
 * Shared Grok API call with retry logic.
 *
 * Returns `GrokSectionResult` on success, `null` on failure after retries.
 */
async function callGrokApi(options: {
	requestBody: ResponsesRequest;
	logContext: Record<string, unknown>;
}): Promise<GrokSectionResult | null> {
	const apiKey = readEnv("XAI_API_KEY");
	if (!apiKey || apiKey.trim() === "") {
		rootLogger.warn("XAI_API_KEY is not set; skipping Grok call", {
			...options.logContext,
			reason: "missing_api_key",
		});
		return null;
	}

	const MAX_RETRIES = 3;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		// warn for non-final attempts because they will escalate to error on
		// exhaustion; the alarm metric filter only fires on error so transient
		// retry churn doesn't page, but a real outage does.
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
				signal: AbortSignal.timeout(
					GROK_TIMEOUT_BY_ATTEMPT_MS[
						Math.min(attempt - 1, GROK_TIMEOUT_BY_ATTEMPT_MS.length - 1)
					] ??
						GROK_TIMEOUT_BY_ATTEMPT_MS[GROK_TIMEOUT_BY_ATTEMPT_MS.length - 1] ??
						30_000,
				),
			});

			if (!response.ok) {
				let bodyPreview: string | undefined;
				try {
					bodyPreview = (await response.text()).slice(0, 500);
				} catch {
					// Body read failed; continue with status-only context.
				}
				const failureContext: Record<string, unknown> = {
					...options.logContext,
					attempt,
					status: response.status,
					statusText: response.statusText,
					...(bodyPreview !== undefined ? { bodyPreview } : {}),
				};
				// 429 is an expected rejection even on exhaustion — rate
				// limiting isn't pageable. Other final-attempt failures
				// log at error so genuine outages surface; tag with
				// `vendor_retry_exhausted` so the ScheduleVendorRetryCount
				// metric filter nets transient Grok exhaustion out of the
				// page-worthy ErrorLogAlarm (matches massive.ts/finnhub.ts).
				if (response.status === 429 && isLastAttempt) {
					rootLogger.info("Grok request rate limited (retries exhausted)", failureContext);
					return null;
				}
				if (isLastAttempt) {
					failureContext.category = "vendor_retry_exhausted";
				}
				log("Grok request failed", failureContext);
				if (!isLastAttempt) {
					await delay(attempt);
					continue;
				}
				return null;
			}

			const data = (await response.json()) as ResponsesResponse;
			const { text, citations } = extractTextAndCitationsFromXaiResponse(data);
			if (!text) {
				const emptyContext: Record<string, unknown> = {
					...options.logContext,
					attempt,
				};
				if (isLastAttempt) {
					emptyContext.category = "vendor_retry_exhausted";
				}
				log("Grok returned empty content", emptyContext);
				if (!isLastAttempt) {
					await delay(attempt);
					continue;
				}
				return null;
			}

			return { content: text, citations };
		} catch (error) {
			const reason =
				error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed";
			const errorContext: Record<string, unknown> = {
				...options.logContext,
				attempt,
				reason,
			};
			if (isLastAttempt) {
				errorContext.category = "vendor_retry_exhausted";
			}
			log("Grok request errored", errorContext, error);
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

	const model = "grok-4.20-non-reasoning";
	const { system, user } = buildNewsPrompt(options);

	return callGrokApi({
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

	return callGrokApi({
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
