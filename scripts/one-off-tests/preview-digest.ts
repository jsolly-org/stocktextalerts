#!/usr/bin/env npx tsx
/**
 * Preview the daily digest email (News + Rumors sections) using the real Grok API.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/preview-digest.ts
 *
 * Writes output to scripts/one-off-tests/preview-digest.html and opens it in the default browser.
 * Shows every stage of the pipeline: raw API -> annotation processing -> HTML rendering.
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { escapeHtml } from "../../src/lib/messaging/asset-formatting";
import {
	markdownLinksToHtml,
	renderEmailSection,
} from "../../src/lib/messaging/email/html-section";
import {
	type XaiAnnotation,
	type ResponsesResponse,
	applyAnnotationsInline,
	buildNewsPrompt,
	buildRumorsPrompt,
} from "../../src/lib/providers/grok";

/* -- Config -- */
const TICKERS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN"];
const LOCAL_DATE_ISO = new Date().toISOString().slice(0, 10);
const TIMEZONE = "America/New_York";
const GROK_TIMEOUT_MS = 45_000;

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
	console.error("XAI_API_KEY not set. Run with: node --env-file-if-exists=.env.local ...");
	process.exit(1);
}

/* -- API call (keeps raw text + annotations for debug display) -- */
/** Call Grok and return raw text + annotations for debugging. */
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
	console.log(`[${label}] Calling Grok API...`);
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
		if (item.type !== "message") continue;
		const content = "content" in item ? item.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if (part.type !== "output_text" && part.type !== "text") continue;
			if ("text" in part && typeof part.text === "string") {
				rawText += part.text.trim();
			}
			if ("annotations" in part && Array.isArray(part.annotations)) {
				annotations = annotations.concat(part.annotations as XaiAnnotation[]);
			}
		}
	}

	const afterAnnotations = applyAnnotationsInline(rawText, annotations);

	return { rawText, annotations, afterAnnotations, rawResponse: data };
}

/* -- Main -- */
/** Script entrypoint: fetch Grok sections and write an HTML preview. */
async function main() {
	console.log(`Fetching Grok news + rumors for ${TICKERS.join(", ")}...\n`);

	const promptOpts = { tickers: TICKERS, localDateIso: LOCAL_DATE_ISO, timezone: TIMEZONE };
	const newsPrompt = buildNewsPrompt(promptOpts);
	const rumorsPrompt = buildRumorsPrompt(promptOpts);

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
		${renderEmailSection("🗞️", "News", news, { showGrokLogo: true, showMassiveLogo: true })}
		${renderEmailSection("🤫", "Rumors", rumors, { showGrokLogo: true })}
		<div style="text-align: center; margin-top: 20px;">
			<a href="#" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">Manage your settings -></a>
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

/** Render a `<details>` block showing each pipeline stage for debugging. */
function buildDebugSection(
	label: string,
	data: Awaited<ReturnType<typeof callGrok>>,
): string {
	if (!data) return `<details><summary>Debug: ${label} (no data)</summary></details>`;

	const annotationRows = data.annotations
		.map((a) => {
			const pos =
				typeof a.start_index === "number" && typeof a.end_index === "number"
					? `[${a.start_index}-${a.end_index}]`
					: "[no pos]";
			const span =
				typeof a.start_index === "number" && typeof a.end_index === "number"
					? data.rawText.slice(a.start_index, a.end_index)
					: "";
			return `<div class="annotation-row"><span class="pos">${escapeHtml(pos)}</span> <span class="span">${escapeHtml(span)}</span> -> <span class="url">${escapeHtml(a.url)}</span></div>`;
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
