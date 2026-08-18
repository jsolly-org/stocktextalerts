import { DateTime } from "luxon";
import { rootLogger } from "../logging";
import {
	formatTickerIdentitySearchBlock,
	identitySearchNames,
} from "../market-notifications/flat-alerts/why-identity";
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

/** Issuer identity for search seeding: a tracked ticker plus its display name and any persisted brands. */
export type DigestAssetIdentity = {
	symbol: string;
	companyName: string;
	aliases?: readonly string[] | null;
};

function stripBold(markdown: string): string {
	return markdown.replace(/\*\*([^*\n]+)\*\*/g, "$1");
}

/** Same ticker-prefix shape as digest extras (`AAPL:` / `SKHY V:`), without pulling Telegram deps. */
const DIGEST_TICKER_LINE_RE = /^([A-Z][A-Z0-9.-]{0,9}(?: [A-Z0-9.-]{1,5})?)(:| — )(.*)$/;

/** Whole-body "nothing there" phrases Grok emits instead of omitting the ticker. */
const EMPTY_TICKER_FILLER_RE =
	/^(?:no(?:thing)?|none)(?: (?:noteworthy|significant|material|relevant|substantial|company specific))?(?: (?:news|rumou?rs?|chatter|reports?|updates?|headlines?|information|items?|coverage))?(?: or (?:unconfirmed )?(?:news|rumou?rs?|chatter|reports?|updates?|headlines?|information))?(?: (?:was|were))?(?: (?:found|surfaced|reported|available|identified|emerged|appeared|today|this session|this period|crossed the wire))*(?: to report)?$/;

function stripLeadingListMarker(line: string): string {
	return line.replace(/^[-*]\s+/, "");
}

function normalizeTickerBody(body: string): string {
	return body
		.replace(/\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[*_`#]/g, "")
		.replace(/[.,;:!?…'"“”‘’()[\]/-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function isEmptyTickerSnippetBody(body: string): boolean {
	const trimmed = body.trim();
	if (trimmed.length === 0) return true;
	return EMPTY_TICKER_FILLER_RE.test(normalizeTickerBody(trimmed));
}

function splitTickerSnippets(markdown: string): string[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const snippets: string[] = [];
	let current: string[] = [];

	const flush = () => {
		const text = current.join("\n").trim();
		if (text) snippets.push(text);
		current = [];
	};

	for (const rawLine of lines) {
		const line = stripLeadingListMarker(rawLine);
		if (DIGEST_TICKER_LINE_RE.test(line)) {
			flush();
			current.push(line);
			continue;
		}
		if (current.length > 0) {
			current.push(line);
		}
	}
	flush();
	return snippets;
}

function tickerSnippetBody(snippet: string): string {
	const lines = snippet.split("\n");
	const first = lines[0] ?? "";
	const match = DIGEST_TICKER_LINE_RE.exec(first);
	if (!match) return snippet.trim();
	const rest = (match[3] ?? "").trim();
	return [rest, ...lines.slice(1)].join("\n").trim();
}

/**
 * Drop ticker bullets whose body is empty or a "nothing found" filler.
 * Grok is already told to skip those tickers; this strips the ones it still emits.
 */
export function omitEmptyTickerSnippets(markdown: string): string {
	const kept = splitTickerSnippets(markdown).filter(
		(snippet) => !isEmptyTickerSnippetBody(tickerSnippetBody(snippet)),
	);
	return kept.join("\n\n");
}

function omitEmptyTickersRule(bulletCount: number): string {
	return (
		`- One bullet per ticker, up to ${bulletCount}. Skip tickers with nothing noteworthy — omit them entirely.\n` +
		`- Never write filler such as "No noteworthy chatter found", "No news found", or "Nothing to report".`
	);
}

/** Search-seeding names per ticker so Grok looks for brands, not cashtags. */
function buildIdentityBlock(identities: readonly DigestAssetIdentity[] | undefined): string {
	if (!identities || identities.length === 0) return "";
	return formatTickerIdentitySearchBlock(
		identities.map((identity) => ({
			symbol: identity.symbol,
			names: identitySearchNames({
				symbol: identity.symbol,
				companyName: identity.companyName,
				persistedAliases: identity.aliases,
			}),
		})),
	);
}

function buildNewsPrompt(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	identities?: readonly DigestAssetIdentity[];
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
		? `\nHere are recent headlines for context (incomplete / roundup-prone, not a primary source):\n${options.providerNewsContext}\n`
		: "";

	const identityBlock = buildIdentityBlock(options.identities);
	const bulletCount = Math.min(options.tickers.length, 10);
	const user =
		`Write a short news summary for these tickers: ${tickers}.\n` +
		`Local date: ${options.localDateIso} (${options.timezone}).\n` +
		(identityBlock !== "" ? `${identityBlock}\n` : "") +
		newsContextBlock +
		"\nRules:\n" +
		`${omitEmptyTickersRule(bulletCount)}\n` +
		"- Search the issuer identity names above, not the ticker symbol alone.\n" +
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
	identities?: readonly DigestAssetIdentity[];
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

	const identityBlock = buildIdentityBlock(options.identities);
	const bulletCount = Math.min(options.tickers.length, 10);
	const user =
		`Write a short rumors summary for these tickers: ${tickers}.\n` +
		`Local date: ${options.localDateIso} (${options.timezone}).\n` +
		(identityBlock !== "" ? `${identityBlock}\n` : "") +
		"\nRules:\n" +
		`${omitEmptyTickersRule(bulletCount)}\n` +
		"- Search the issuer identity names above, not the cashtag alone.\n" +
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
	const content = omitEmptyTickerSnippets(stripBold(annotated));
	if (!content) {
		rootLogger.info("Grok digest section had no noteworthy ticker items; omit section", {
			...options.logContext,
		});
		return null;
	}
	return { content, citations: [] };
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
	identities?: readonly DigestAssetIdentity[];
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
	identities?: readonly DigestAssetIdentity[];
	requestId?: string;
}): Promise<GrokSectionResult | null> {
	if (options.tickers.length === 0) return null;

	const model = GROK_DIGEST_MODEL;
	const { system, user } = buildRumorsPrompt(options);
	const fromDate = DateTime.fromISO(options.localDateIso, { zone: options.timezone })
		.minus({ days: 1 })
		.toISODate();
	const xSearchTool =
		fromDate !== null
			? { type: "x_search" as const, from_date: fromDate, to_date: options.localDateIso }
			: { type: "x_search" as const };

	return callGrokSectionApi({
		requestBody: {
			model,
			instructions: system,
			input: user,
			temperature: 0.4,
			max_output_tokens: 800,
			reasoning_effort: "none",
			tools: [xSearchTool],
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
