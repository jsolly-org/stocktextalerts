// xAI Responses API (OpenAPI `ModelResponse`)
export type XaiAnnotation = {
	type: string;
	url: string;
	title?: string;
	start_index?: number | null;
	end_index?: number | null;
};

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

/**
 * Derive a human-readable link label from a URL.
 *
 * - X/Twitter posts → `@handle` (or null for anonymous `/i/` links)
 * - Known news domains → friendly name (e.g. "CNBC")
 * - Other URLs → bare domain (e.g. "example.com")
 */
function linkLabelFromUrl(url: string): string | null {
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
