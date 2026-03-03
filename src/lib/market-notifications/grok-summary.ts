import { rootLogger } from "../logging";
import { linkLabelFromUrl } from "../providers/grok";

const GROK_TIMEOUT_MS = 60_000;

/** A single link returned by Grok for a price alert. */
export interface PriceAlertLink {
	url: string;
	title: string;
	source: string;
	sourceType: "x" | "web";
}

/** Structured result from a Grok price alert call: summary + up to 3 links. */
export interface PriceAlertGrokResult {
	summary: string;
	links: PriceAlertLink[];
}

/** Determine whether a URL is from X/Twitter. */
function isXUrl(url: string): boolean {
	return /^https?:\/\/(?:x|twitter)\.com\//.test(url);
}

// xAI Responses API types (minimal subset for price alert parsing)
type XaiAnnotation = {
	type: string;
	url: string;
	title?: string;
	start_index?: number | null;
	end_index?: number | null;
};

type XaiOutputContentPart = {
	type?: string;
	text?: string;
	annotations?: XaiAnnotation[];
};

type XaiOutputItem = {
	type?: string;
	content?: XaiOutputContentPart[];
};

type ResponsesResponse = {
	output?: XaiOutputItem[];
};

/**
 * Extract the summary text and up to 3 unique links from a Grok Responses API payload.
 */
function parseGrokPriceAlertResponse(
	data: ResponsesResponse,
): PriceAlertGrokResult | null {
	let summaryText: string | null = null;
	const seenUrls = new Set<string>();
	const links: PriceAlertLink[] = [];

	for (const item of data.output ?? []) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (
				(part.type === "output_text" || part.type === "text") &&
				typeof part.text === "string" &&
				part.text.trim() !== ""
			) {
				if (!summaryText) {
					summaryText = part.text.trim();
				}

				// Extract links from annotations
				for (const ann of part.annotations ?? []) {
					const normalizedUrl =
						typeof ann.url === "string" ? ann.url.trim() : "";
					if (normalizedUrl === "" || seenUrls.has(normalizedUrl)) {
						continue;
					}
					if (links.length >= 3) break;

					seenUrls.add(normalizedUrl);
					const url = normalizedUrl;
					const sourceType: "x" | "web" = isXUrl(url) ? "x" : "web";
					const source =
						linkLabelFromUrl(url) ??
						(sourceType === "x" ? "X post" : "article");
					const title = ann.title?.trim() || source;

					links.push({ url, title, source, sourceType });
				}
			}
		}
	}

	// Also extract links from inline markdown in the text (Grok sometimes embeds [text](url) directly)
	if (summaryText && links.length < 3) {
		const mdLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
		for (const match of summaryText.matchAll(mdLinkRegex)) {
			if (links.length >= 3) break;
			const url = match[2].trim();
			if (seenUrls.has(url)) continue;
			seenUrls.add(url);
			const sourceType: "x" | "web" = isXUrl(url) ? "x" : "web";
			const source =
				linkLabelFromUrl(url) ?? (sourceType === "x" ? "X post" : "article");
			const title = match[1].trim() || source;
			links.push({ url, title, source, sourceType });
		}
	}

	if (!summaryText) return null;

	// Strip inline markdown links and citation markers from the summary for clean display
	let cleanSummary = summaryText
		.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
		.replace(/\[\[(\d+)\]\]/g, "")
		.replace(/<grok:render[^>]*>[\s\S]*?<\/grok:render>/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();

	// Truncate to ~2 sentences if Grok got verbose
	const sentences = cleanSummary.match(/[^.!?]+[.!?]+/g);
	if (sentences && sentences.length > 2) {
		cleanSummary = sentences.slice(0, 2).join("").trim();
	}

	return { summary: cleanSummary, links };
}

/**
 * Generate a price alert summary + relevant links using Grok with web_search and x_search.
 *
 * Single attempt with 60s timeout. Returns null on failure.
 */
export async function generatePriceAlertSummary(options: {
	symbol: string;
	priceContext: string;
	signalContext: string;
}): Promise<PriceAlertGrokResult | null> {
	const apiKey = process.env.XAI_API_KEY;
	if (!apiKey || apiKey.trim() === "") {
		return null;
	}

	const prompt =
		`${options.symbol}: ${options.priceContext}. ` +
		`Signals: ${options.signalContext}.\n\n` +
		"Search the web and X/Twitter for the most relevant explanations of this stock move. " +
		"Write 1-2 neutral, factual sentences summarizing why this move is happening. " +
		"Do not give investment advice. " +
		"Include up to 3 of the most relevant source links (news articles or X posts).";

	try {
		const response = await fetch("https://api.x.ai/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "grok-4-1-fast-non-reasoning",
				instructions:
					"You write brief, neutral asset price alert summaries with source links. No buy/sell advice.",
				input: prompt,
				temperature: 0.3,
				max_tokens: 400,
				tools: [{ type: "web_search" }, { type: "x_search" }],
			}),
			signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
		});

		if (!response.ok) {
			rootLogger.warn("Grok price alert summary failed", {
				status: response.status,
			});
			return null;
		}

		const data = (await response.json()) as ResponsesResponse;
		return parseGrokPriceAlertResponse(data);
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TimeoutError"
				? "timeout"
				: "request_failed";
		rootLogger.warn("Grok price alert summary error", { reason }, error);
		return null;
	}
}
