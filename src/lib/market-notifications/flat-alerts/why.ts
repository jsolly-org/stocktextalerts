import { rootLogger } from "../../logging";
import {
	fetchGrokResponse,
	type GrokResponsesRequest,
	type GrokResponsesResponse,
} from "../../vendors/grok";
import { applyAnnotationsInline, type XaiAnnotation } from "../../vendors/grok-citations";

export type PriceMoveWhyVerdict = "same" | "updated" | "new" | "unknown";

export type PriceMoveWhyResult = {
	text: string;
	verdict: PriceMoveWhyVerdict;
};

const UNKNOWN_TEXT = "No clear catalyst on the wire.";
const UNKNOWN_ACCEL_TEXT = "Still no clear catalyst on the wire.";

const VERDICTS: readonly PriceMoveWhyVerdict[] = ["same", "updated", "new", "unknown"];

function extractTextFromXaiResponse(response: GrokResponsesResponse): string | null {
	const texts: string[] = [];

	const addText = (value: unknown, annotations?: unknown) => {
		if (typeof value !== "string") return;
		const trimmed = value.trim();
		if (trimmed === "") return;
		const annotated = Array.isArray(annotations)
			? applyAnnotationsInline(trimmed, annotations as XaiAnnotation[])
			: trimmed;
		const stripped = annotated.replace(/\*\*([^*\n]+)\*\*/g, "$1");
		texts.push(stripped);
	};

	const output = Array.isArray(response.output) ? response.output : [];
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
		}
	}

	const text = texts.join("\n").trim();
	return text === "" ? null : text;
}

/** Parse a verdict marker from model output; defaults to unknown when ambiguous. */
export function parsePriceMoveWhyVerdict(raw: string): PriceMoveWhyVerdict {
	const firstLine = raw.split(/\r?\n/, 1)[0] ?? raw;
	const upper = firstLine.toUpperCase();

	// Structured first line: VERDICT: same | UPDATED | NEW | UNKNOWN
	const structured = firstLine.match(
		/^\s*(?:verdict\s*[:=]\s*)?(same|updated|new|unknown)\s*[:.-]?\s*$/i,
	);
	if (structured?.[1]) {
		return structured[1].toLowerCase() as PriceMoveWhyVerdict;
	}

	for (const verdict of VERDICTS) {
		const token = verdict.toUpperCase();
		if (
			upper.includes(`VERDICT: ${token}`) ||
			upper.includes(`VERDICT=${token}`) ||
			upper.startsWith(`${token}:`) ||
			upper.startsWith(`[${token}]`) ||
			upper.includes(`(${token})`)
		) {
			return verdict;
		}
	}

	return "unknown";
}

/** Strip a leading verdict marker line / prefix from the user-facing blurb. */
export function stripVerdictMarker(raw: string): string {
	const lines = raw.split(/\r?\n/);
	if (lines.length === 0) return raw.trim();

	const first = lines[0] ?? "";
	if (/^\s*(?:verdict\s*[:=]\s*)?(same|updated|new|unknown)\s*[:.-]?\s*$/i.test(first)) {
		return lines.slice(1).join("\n").trim();
	}

	const strippedFirst = first
		.replace(/^\s*\[?(?:VERDICT\s*[:=]\s*)?(same|updated|new|unknown)\]?\s*[:.-]?\s*/i, "")
		.trim();
	if (strippedFirst !== first.trim()) {
		lines[0] = strippedFirst;
		return lines.join("\n").trim();
	}

	return raw.trim();
}

function applyContinuityLeadIn(
	text: string,
	verdict: PriceMoveWhyVerdict,
	isAcceleration: boolean,
	hadPrior: boolean,
): string {
	const trimmed = text.trim();
	if (verdict === "unknown") {
		if (hadPrior && isAcceleration) {
			return UNKNOWN_ACCEL_TEXT;
		}
		return UNKNOWN_TEXT;
	}

	if (!hadPrior || trimmed === "") {
		return trimmed;
	}

	// Preserve model lead-ins when already present; otherwise add short continuity phrases.
	const lower = trimmed.toLowerCase();
	if (
		lower.startsWith("still ") ||
		lower.startsWith("update:") ||
		lower.startsWith("updated:") ||
		lower.startsWith("new catalyst:") ||
		lower.startsWith("new:") ||
		lower.startsWith("same story:")
	) {
		return trimmed;
	}

	switch (verdict) {
		case "same":
			return `Still the same story: ${trimmed}`;
		case "updated":
			return `Update: ${trimmed}`;
		case "new":
			return `New catalyst: ${trimmed}`;
		default:
			return trimmed;
	}
}

function buildWhyPrompt(options: {
	symbol: string;
	companyName?: string;
	triggerPercent: number;
	isAcceleration: boolean;
	priorWhySummary: string | null;
	priorWhyVerdict: PriceMoveWhyVerdict | null;
}): { system: string; user: string } {
	const { symbol, companyName, triggerPercent, isAcceleration, priorWhySummary, priorWhyVerdict } =
		options;
	const direction = triggerPercent >= 0 ? "up" : "down";
	const absPct = Math.abs(triggerPercent).toFixed(1);
	const name = companyName && companyName.trim() !== "" ? companyName.trim() : symbol;

	const system =
		"You explain short-term US equity price moves for alert notifications. " +
		"Be factual, neutral, and concise (1–2 sentences). " +
		"Do not give buy/sell advice. " +
		"Cite claims with markdown links `[Source](https://...)` using real URLs from search — never invent URLs. " +
		"Plain text otherwise — no markdown bold/italic/headings/bullets beyond citation links. " +
		"When a prior why is provided, classify continuity as SAME, UPDATED, NEW, or UNKNOWN.";

	const priorBlock =
		priorWhySummary && priorWhySummary.trim() !== ""
			? `\nPrior why (same trading day; previous verdict=${priorWhyVerdict ?? "unknown"}):\n${priorWhySummary.trim()}\n`
			: "\nNo prior why today.\n";

	const accelNote = isAcceleration
		? "This alert is an acceleration (same-direction continuation since the last alert).\n"
		: "";

	const user =
		`Explain THIS move for ${symbol} (${name}): ${direction} ${absPct}%.\n` +
		accelNote +
		priorBlock +
		"\nOutput format:\n" +
		"Line 1: VERDICT: same|updated|new|unknown\n" +
		"Line 2+: 1–2 sentence explanation of the catalyst for this move.\n" +
		"If there is no clear catalyst, use VERDICT: unknown and a short hedge " +
		`like "${UNKNOWN_TEXT}".\n` +
		"When prior why exists and the story is unchanged, prefer VERDICT: same and a brief continuity lead-in.\n" +
		"When the story evolved, VERDICT: updated. When a distinct new catalyst, VERDICT: new.";

	return { system, user };
}

/**
 * Generate a short "why" blurb for a price-move alert via Grok (web_search + x_search).
 * Fail-open: returns null on any failure / missing key / empty content.
 */
export async function generatePriceMoveWhyWithGrok(options: {
	symbol: string;
	companyName?: string;
	triggerPercent: number;
	isAcceleration: boolean;
	priorWhySummary: string | null;
	priorWhyVerdict: PriceMoveWhyVerdict | null;
	requestId?: string;
}): Promise<PriceMoveWhyResult | null> {
	const model = "grok-4.5";
	const hadPrior = Boolean(options.priorWhySummary && options.priorWhySummary.trim() !== "");
	const { system, user } = buildWhyPrompt(options);

	const requestBody: GrokResponsesRequest = {
		model,
		instructions: system,
		input: user,
		temperature: 0.3,
		max_output_tokens: 200,
		reasoning_effort: "low",
		tools: [{ type: "web_search" }, { type: "x_search" }],
	};

	try {
		const data = await fetchGrokResponse({
			requestBody,
			logContext: {
				action: "price_move_why",
				model,
				symbol: options.symbol,
				requestId: options.requestId,
			},
		});
		if (!data) {
			return null;
		}

		const raw = extractTextFromXaiResponse(data);
		if (!raw) {
			rootLogger.warn("Price-move why Grok returned empty content", {
				action: "price_move_why",
				symbol: options.symbol,
			});
			return null;
		}

		const verdict = hadPrior ? parsePriceMoveWhyVerdict(raw) : "new";
		const body = stripVerdictMarker(raw);
		const text = applyContinuityLeadIn(
			body === "" ? UNKNOWN_TEXT : body,
			verdict === "unknown" || body === "" ? "unknown" : verdict,
			options.isAcceleration,
			hadPrior,
		);

		const finalVerdict: PriceMoveWhyVerdict =
			text === UNKNOWN_TEXT || text === UNKNOWN_ACCEL_TEXT ? "unknown" : verdict;

		return { text, verdict: finalVerdict };
	} catch (error) {
		rootLogger.warn(
			"Price-move why Grok call failed open",
			{ action: "price_move_why", symbol: options.symbol },
			error,
		);
		return null;
	}
}
