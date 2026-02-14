#!/usr/bin/env npx tsx
/**
 * Preview the daily digest email (News + Rumors sections) using the real Grok API.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/preview-digest.ts
 *
 * Writes output to scripts/preview-digest.html and opens it in the default browser.
 * Shows every stage of the pipeline: raw API → annotation processing → HTML rendering.
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { escapeHtml } from "../src/lib/messaging/asset-formatting";
import {
	markdownLinksToHtml,
	renderEmailSection,
} from "../src/lib/messaging/email/html-section";

/* ── xAI types (mirrors grok.ts) ── */
type XaiAnnotation = {
	type: string;
	url: string;
	start_index?: number | null;
	end_index?: number | null;
};
type XaiOutputContentPart = {
	type: string;
	text?: string;
	annotations?: XaiAnnotation[];
};
type XaiOutputItem = {
	type: string;
	content?: XaiOutputContentPart[];
};
type ResponsesResponse = {
	id: string;
	output: XaiOutputItem[];
};

/* ── Mirrors linkLabelFromUrl + applyAnnotationsInline from grok.ts ── */
const DOMAIN_LABELS: Record<string, string> = {
	"cnbc.com": "CNBC", "finance.yahoo.com": "Yahoo Finance", "yahoo.com": "Yahoo",
	"investopedia.com": "Investopedia", "seekingalpha.com": "Seeking Alpha",
	"morningstar.com": "Morningstar", "marketwatch.com": "MarketWatch",
	"bloomberg.com": "Bloomberg", "reuters.com": "Reuters", "wsj.com": "WSJ",
	"barrons.com": "Barron's", "fool.com": "Motley Fool", "marketbeat.com": "MarketBeat",
	"benzinga.com": "Benzinga", "thestreet.com": "TheStreet", "tradingview.com": "TradingView",
	"trefis.com": "Trefis", "electrek.co": "Electrek", "techcrunch.com": "TechCrunch",
	"theverge.com": "The Verge", "arstechnica.com": "Ars Technica",
};
function linkLabelFromUrl(url: string): string | null {
	const xMatch = url.match(/^https?:\/\/(?:x|twitter)\.com\/([^/]+)\/status\/\d+/);
	if (xMatch) return xMatch[1] === "i" ? null : `@${xMatch[1]}`;
	try {
		const hostname = new URL(url).hostname.replace(/^www\./, "");
		if (DOMAIN_LABELS[hostname]) return DOMAIN_LABELS[hostname];
		const parts = hostname.split(".");
		if (parts.length > 2) { const parent = parts.slice(-2).join("."); if (DOMAIN_LABELS[parent]) return DOMAIN_LABELS[parent]; }
		return hostname;
	} catch { return null; }
}

function applyAnnotationsInline(text: string, annotations: XaiAnnotation[]): string {
	const valid = annotations
		.filter(
			(a): a is XaiAnnotation & { start_index: number; end_index: number } =>
				typeof a.url === "string" && a.url.trim() !== "" &&
				typeof a.start_index === "number" && typeof a.end_index === "number" &&
				a.start_index >= 0 && a.end_index > a.start_index && a.end_index <= text.length,
		)
		.sort((a, b) => b.start_index - a.start_index);

	let result = text;

	for (const ann of valid) {
		const span = result.slice(ann.start_index, ann.end_index);
		if (/\]\(https?:\/\//.test(span)) continue;
		const after = result.slice(ann.end_index, ann.end_index + 10);
		if (/^\]?\(https?:/.test(after)) continue;
		let linkText = span.replace(/^\[|\]$/g, "").trim();
		if (!linkText || /^post:\d+$/i.test(linkText)) linkText = "source";
		result = result.slice(0, ann.start_index) + `[${linkText}](${ann.url})` + result.slice(ann.end_index);
	}

	let linkCounter = 0;
	result = result.replace(/\[?\[(?:post|web):(\d+)\]\]?/g, (_match, numStr) => {
		const idx = parseInt(numStr as string, 10);
		const ann = annotations[idx];
		if (ann && typeof ann.url === "string" && ann.url.trim() !== "") {
			linkCounter++;
			const url = ann.url.trim();
			return `[[${linkLabelFromUrl(url) ?? `[${linkCounter}]`}]](${url})`;
		}
		return "";
	});

	result = result.replace(
		/\[https?:\/\/(?:x|twitter)\.com\/([^/\]]+)\/status\/[^\]]+\]/g,
		(_, handle) => (handle === "i" ? "[[post]]" : `[[@${handle}]]`),
	);

	result = result.replace(/\[\[(\d+)\]\]\((https?:\/\/[^)]+)\)/g, (_match, _num, url) => {
		const label = linkLabelFromUrl(url as string);
		return label ? `[[${label}]](${url})` : _match;
	});

	// Phase 5: Link inline @handle mentions to anonymous x_search citation URLs.
	const anonXUrls: string[] = [];
	for (const m of result.matchAll(
		/\[\[\d+\]\]\((https?:\/\/(?:x|twitter)\.com\/i\/status\/\d+)\)/g,
	)) {
		anonXUrls.push(m[1]);
	}
	if (anonXUrls.length > 0) {
		result = result.replace(
			/\[\[\d+\]\]\(https?:\/\/(?:x|twitter)\.com\/i\/status\/\d+\)/g,
			"",
		);
		let anonIdx = 0;
		result = result.replace(/(?<!\[)@([A-Za-z0-9_]+)/g, (match) => {
			if (anonIdx < anonXUrls.length) {
				return `[[${match}]](${anonXUrls[anonIdx++]})`;
			}
			return match;
		});
	}

	return result;
}

/* ── Config ── */
const TICKERS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN"];
const LOCAL_DATE_ISO = new Date().toISOString().slice(0, 10);
const TIMEZONE = "America/New_York";
const GROK_TIMEOUT_MS = 45_000;

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
	console.error("XAI_API_KEY not set. Run with: node --env-file-if-exists=.env.local ...");
	process.exit(1);
}

/* ── Build prompts (mirrors grok.ts) ── */
function buildNewsPrompt() {
	const tickers = TICKERS.join(", ");
	const bulletCount = Math.min(TICKERS.length, 10);
	return {
		system:
			"You write factual financial news summaries for daily email digests. " +
			"Be descriptive, neutral, and cautious. " +
			"Do not give buy/sell advice. " +
			"Do NOT include links, URLs, or citation numbers in your text — " +
			"source links are added automatically from search metadata.",
		user:
			`Write a short news summary for these tickers: ${tickers}.\n` +
			`Local date: ${LOCAL_DATE_ISO} (${TIMEZONE}).\n` +
			"\nRules:\n" +
			`- One bullet per ticker, up to ${bulletCount}. Skip tickers with nothing noteworthy.\n` +
			"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
			"- Do NOT include links or citation markers — they are added automatically.\n" +
			"- Output the bullets directly — no wrappers, tags, or preamble.\n" +
			"\nExample output:\n" +
			"AAPL: Apple shares fell 3% after the FTC opened an inquiry into App Store practices, adding to concerns over slowing services revenue.\n" +
			"NVDA: Nvidia declined 2% as competition from AMD accelerators intensified ahead of next week's earnings report.",
	};
}

function buildRumorsPrompt() {
	const tickers = TICKERS.join(", ");
	const bulletCount = Math.min(TICKERS.length, 10);
	return {
		system:
			"You summarize social media chatter and unverified rumors about stocks. " +
			"Use hedge words like 'chatter', 'unconfirmed', and 'reportedly'. " +
			"Do not give buy/sell advice. " +
			"Attribute claims to specific X posters by their @handle. " +
			"Do NOT include full URLs — just @handles.",
		user:
			`Write a short rumors summary for these tickers: ${tickers}.\n` +
			`Local date: ${LOCAL_DATE_ISO} (${TIMEZONE}).\n` +
			"\nRules:\n" +
			`- One bullet per ticker, up to ${bulletCount}. Skip tickers with nothing noteworthy.\n` +
			"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
			"- Attribute claims to specific X posters using their @handle.\n" +
			"- Do NOT include full URLs or citation markers — they are added automatically.\n" +
			"- End with: 'Unverified chatter — double-check before acting.'\n" +
			"- Output the bullets directly — no wrappers, tags, or preamble.\n" +
			"\nExample output:\n" +
			"AAPL: Chatter about Siri delays pressuring shares, with @TechBullish flagging supply chain friction and @MarketWatcher noting strong China sales as an offset.\n" +
			"NVDA: @ChipAnalyst reports UBS raising PT to $245 ahead of earnings, while @OptionsFlow highlights aggressive upside bets.\n" +
			"Unverified chatter — double-check before acting.",
	};
}

/* ── API call ── */
async function callGrok(
	label: string,
	system: string,
	user: string,
	tool: "web_search" | "x_search",
): Promise<{
	rawText: string;
	annotations: XaiAnnotation[];
	afterAnnotations: string;
	rawResponse: ResponsesResponse;
} | null> {
	console.log(`[${label}] Calling Grok API…`);
	const response = await fetch("https://api.x.ai/v1/responses", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "grok-4-1-fast-non-reasoning",
			instructions: system,
			input: user,
			temperature: 0.4,
			max_tokens: 800,
			tools: [{ type: tool }],
		}),
		signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
	});

	if (!response.ok) {
		console.error(`[${label}] API error: ${response.status} ${response.statusText}`);
		return null;
	}

	const data = (await response.json()) as ResponsesResponse;

	// Extract raw text + annotations from the response
	let rawText = "";
	let annotations: XaiAnnotation[] = [];
	for (const item of data.output) {
		if (item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (part.type !== "output_text" && part.type !== "text") continue;
			rawText += (part.text ?? "").trim();
			if (Array.isArray(part.annotations)) {
				annotations = annotations.concat(part.annotations);
			}
		}
	}

	const afterAnnotations = applyAnnotationsInline(rawText, annotations);

	return { rawText, annotations, afterAnnotations, rawResponse: data };
}

/* ── Main ── */
async function main() {
	console.log(`Fetching Grok news + rumors for ${TICKERS.join(", ")}…\n`);

	const newsPrompt = buildNewsPrompt();
	const rumorsPrompt = buildRumorsPrompt();

	const [newsData, rumorsData] = await Promise.all([
		callGrok("News", newsPrompt.system, newsPrompt.user, "web_search"),
		callGrok("Rumors", rumorsPrompt.system, rumorsPrompt.user, "x_search"),
	]);

	const news = newsData?.afterAnnotations ?? "";
	const rumors = rumorsData?.afterAnnotations ?? "";

	// Console debug
	for (const [label, data] of [["NEWS", newsData], ["RUMORS", rumorsData]] as const) {
		console.log(`\n${"=".repeat(60)}`);
		console.log(`  ${label}`);
		console.log(`${"=".repeat(60)}`);
		if (!data) {
			console.log("(no data)");
			continue;
		}
		console.log("\n--- RAW TEXT (before annotation processing) ---");
		console.log(data.rawText);
		console.log(`\n--- ANNOTATIONS (${data.annotations.length} total) ---`);
		for (const a of data.annotations) {
			console.log(
				`  [${a.start_index ?? "?"}-${a.end_index ?? "?"}] ${a.url}` +
					(typeof a.start_index === "number" && typeof a.end_index === "number"
						? `  span="${data.rawText.slice(a.start_index, a.end_index)}"`
						: "  (no position)"),
			);
		}
		console.log("\n--- AFTER applyAnnotationsInline ---");
		console.log(data.afterAnnotations);
		console.log("\n--- AFTER markdownLinksToHtml ---");
		console.log(markdownLinksToHtml(data.afterAnnotations));
	}

	const tickersLine = `Tickers: ${TICKERS.join(", ")}`;

	const html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Daily Digest Preview</title>
	<style>
		details { margin-top: 24px; font-family: monospace; font-size: 12px; }
		details summary { cursor: pointer; font-size: 14px; font-weight: bold; margin-bottom: 8px; }
		details pre { white-space: pre-wrap; background: #f1f5f9; padding: 12px; border-radius: 6px; margin: 4px 0 16px; }
		details h4 { margin: 12px 0 4px; }
		.annotation-row { padding: 2px 0; }
		.annotation-row .pos { color: #6366f1; }
		.annotation-row .span { color: #dc2626; font-weight: bold; }
		.annotation-row .url { color: #059669; }
	</style>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 800px; margin: 0 auto; padding: 20px;">

	<!-- EMAIL PREVIEW -->
	<h1 style="font-size: 16px; color: #6b7280; margin-bottom: 4px;">Email Preview</h1>
	<div style="background: #ffffff; padding: 24px; border: 1px solid #e5e7eb; border-radius: 10px; max-width: 600px;">
		<h2 style="margin: 0 0 8px; font-size: 18px;">Daily digest</h2>
		<p style="margin: 0 0 16px; color: #6b7280; font-size: 14px;">${escapeHtml(tickersLine)}</p>
		${renderEmailSection("🗞️", "News", news, { showGrokLogo: true, showFinnhubLogo: true })}
		${renderEmailSection("🤫", "Rumors", rumors, { showGrokLogo: true })}
		<div style="text-align: center; margin-top: 20px;">
			<a href="#" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">Manage your settings →</a>
		</div>
	</div>

	<!-- DEBUG: PIPELINE STAGES -->
	${buildDebugSection("News", newsData)}
	${buildDebugSection("Rumors", rumorsData)}
</body>
</html>`;

	const outPath = new URL("preview-digest.html", import.meta.url).pathname;
	writeFileSync(outPath, html, "utf-8");
	console.log(`\nWrote ${outPath}`);
	execSync(`open "${outPath}"`);
}

function buildDebugSection(
	label: string,
	data: Awaited<ReturnType<typeof callGrok>>,
): string {
	if (!data) return `<details><summary>Debug: ${label} (no data)</summary></details>`;

	const annotationRows = data.annotations
		.map((a) => {
			const pos =
				typeof a.start_index === "number" && typeof a.end_index === "number"
					? `[${a.start_index}–${a.end_index}]`
					: "[no pos]";
			const span =
				typeof a.start_index === "number" && typeof a.end_index === "number"
					? data.rawText.slice(a.start_index, a.end_index)
					: "";
			return `<div class="annotation-row"><span class="pos">${escapeHtml(pos)}</span> <span class="span">${escapeHtml(span)}</span> → <span class="url">${escapeHtml(a.url)}</span></div>`;
		})
		.join("");

	return `
	<details>
		<summary>Debug: ${escapeHtml(label)} pipeline (${data.annotations.length} annotations)</summary>
		<h4>1. Raw API text (before annotation processing)</h4>
		<pre>${escapeHtml(data.rawText)}</pre>
		<h4>2. Annotations</h4>
		<div style="background: #f1f5f9; padding: 12px; border-radius: 6px; margin-bottom: 16px;">${annotationRows || "<em>none</em>"}</div>
		<h4>3. After applyAnnotationsInline</h4>
		<pre>${escapeHtml(data.afterAnnotations)}</pre>
		<h4>4. After markdownLinksToHtml (final HTML)</h4>
		<pre>${escapeHtml(markdownLinksToHtml(data.afterAnnotations))}</pre>
		<h4>5. Rendered HTML</h4>
		<div style="background: #f9fafb; padding: 12px; border-radius: 8px; border: 1px solid #e5e7eb; font-size: 13px;">${markdownLinksToHtml(data.afterAnnotations)}</div>
	</details>`;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
