import type { PriceAlertGrokResult } from "../price-alerts/types";
import { fetchGrokResponseOnce, type GrokResponsesResponse } from "../vendors/grok";
import {
	applyAnnotationsInline,
	isXUrl,
	linkLabelFromUrl,
	type XaiAnnotation,
} from "../vendors/grok-citations";

const GROK_TIMEOUT_MS = 60_000;

/** Validate and normalize model-sourced URLs to http(s) only; reject other schemes. */
function normalizeHttpUrl(raw: string): string | null {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}

function parseGrokPriceAlertResponse(data: GrokResponsesResponse): PriceAlertGrokResult | null {
	let summaryText: string | null = null;
	let summaryAnnotations: XaiAnnotation[] = [];
	const seenUrls = new Set<string>();
	const links: PriceAlertGrokResult["links"] = [];

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
					summaryAnnotations = Array.isArray(part.annotations)
						? (part.annotations as XaiAnnotation[])
						: [];
				}

				// Extract links from annotations for plaintext/SMS fallback
				const annotations = Array.isArray(part.annotations)
					? (part.annotations as XaiAnnotation[])
					: [];
				for (const ann of annotations) {
					const normalizedUrl =
						typeof ann.url === "string" ? normalizeHttpUrl(ann.url.trim()) : null;
					if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
						continue;
					}
					if (links.length >= 3) break;

					seenUrls.add(normalizedUrl);
					const url = normalizedUrl;
					const sourceType: "x" | "web" = isXUrl(url) ? "x" : "web";
					const source = linkLabelFromUrl(url) || (sourceType === "x" ? "X post" : "article");
					const title = ann.title?.trim() || source;

					links.push({ url, title, source, sourceType });
				}
			}
		}
	}

	if (!summaryText) return null;

	// Apply annotations as inline markdown links (same pipeline as daily digest)
	let summary = applyAnnotationsInline(summaryText, summaryAnnotations);

	// Strip bare URLs that Grok embeds alongside citation markers —
	// the annotation pipeline converts markers to markdown links but leaves
	// the raw URL text in place (e.g. "https://url [[source]](url)").
	// The lookbehind (?<!\]\() preserves URLs inside markdown link syntax.
	// Also strip stray markdown bold markers — the renderer doesn't expect
	// them and non-reasoning Grok models occasionally wrap content in `**…**`.
	summary = summary
		.replace(/(?<!\]\()https?:\/\/[^\s)[\]]+/g, "")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/\n{2,}/g, "\n")
		.replace(/\s{2,}/g, " ")
		.trim();

	// Also extract links from any inline markdown the model embedded directly
	if (links.length < 3) {
		const mdLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
		for (const match of summaryText.matchAll(mdLinkRegex)) {
			if (links.length >= 3) break;
			const [, captureTitle, captureUrl] = match;
			if (!captureUrl) continue;
			const url = normalizeHttpUrl(captureUrl.trim());
			if (!url || seenUrls.has(url)) continue;
			seenUrls.add(url);
			const sourceType: "x" | "web" = isXUrl(url) ? "x" : "web";
			const source = linkLabelFromUrl(url) || (sourceType === "x" ? "X post" : "article");
			const title = captureTitle?.trim() || source;
			links.push({ url, title, source, sourceType });
		}
	}

	// Truncate to ~2 sentences if Grok got verbose.
	// Split on sentence boundaries (period/excl/question followed by space and capital letter)
	// to avoid false splits on decimals (5.2%) and abbreviations (U.S., S&P).
	const parts = summary.split(/(?<=[.!?])\s+(?=[A-Z])/);
	if (parts.length > 2) {
		summary = parts.slice(0, 2).join(" ").trim();
	}

	// Truncation may have dropped sentences that contained the only reference
	// to some of the collected links. Filter `links` down to URLs that are
	// still reachable from the surviving summary so the invariant
	// "every link in result.links appears as an href in the rendered HTML"
	// holds for downstream callers (email/SMS rendering, tests).
	const reachableLinks = links.filter((link) => summary.includes(link.url));

	return { summary, links: reachableLinks };
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
	const prompt =
		`${options.symbol}: ${options.priceContext}. ` +
		`Signals: ${options.signalContext}.\n\n` +
		"Search the web and X/Twitter for the most relevant explanations of this price move. " +
		"Write 1-2 neutral, factual sentences summarizing why this move is happening. " +
		"Do not give investment advice. " +
		"Include up to 3 of the most relevant source links (news articles or X posts).";

	const data = await fetchGrokResponseOnce({
		requestBody: {
			model: "grok-4.20-non-reasoning",
			instructions:
				"You write brief, neutral asset price alert summaries with source links. No buy/sell advice. " +
				"Output plain text only — no markdown formatting (no **bold**, no *italic*).",
			input: prompt,
			temperature: 0.3,
			max_output_tokens: 400,
			tools: [{ type: "web_search" }, { type: "x_search" }],
		},
		logContext: {
			symbol: options.symbol,
			action: "grok_price_alert",
		},
		timeoutMs: GROK_TIMEOUT_MS,
	});
	if (!data) return null;

	return parseGrokPriceAlertResponse(data);
}
