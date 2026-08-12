import { rootLogger } from "../../logging";
import {
	collectMessageAnnotations,
	fetchGrokResponse,
	type GrokResponsesRequest,
	type GrokTextFormat,
	parseResponsesJsonObject,
} from "../../vendors/grok";
import { applyAnnotationsInline } from "../../vendors/grok-citations";
import { GROK_WHY_MODEL } from "../../vendors/grok-models";

export type PriceMoveWhyVerdict = "same" | "updated" | "new" | "unknown";

export type PriceMoveWhyResult = {
	text: string;
	verdict: PriceMoveWhyVerdict;
};

const UNKNOWN_TEXT = "No clear catalyst on the wire.";
const UNKNOWN_ACCEL_TEXT = "Still no clear catalyst on the wire.";

const PRICE_MOVE_WHY_VERDICTS = ["same", "updated", "new", "unknown"] as const;

export const GROK_WHY_TEXT_FORMAT = {
	type: "json_schema",
	name: "price_move_why",
	strict: true,
	schema: {
		type: "object",
		properties: {
			verdict: { type: "string", enum: [...PRICE_MOVE_WHY_VERDICTS] },
			why: { type: "string" },
		},
		required: ["verdict", "why"],
		additionalProperties: false,
	},
} as const satisfies GrokTextFormat;

function isWhyVerdict(value: unknown): value is PriceMoveWhyVerdict {
	return (
		typeof value === "string" && (PRICE_MOVE_WHY_VERDICTS as ReadonlyArray<string>).includes(value)
	);
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
		"When a prior why is provided, classify continuity as same, updated, new, or unknown via the structured response schema.";

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
		"\nReturn verdict and why via the structured response schema.\n" +
		`If there is no clear catalyst, use verdict unknown and a short hedge like "${UNKNOWN_TEXT}".\n` +
		"When prior why exists and the story is unchanged, prefer verdict same and a brief continuity lead-in.\n" +
		"When the story evolved, verdict updated. When a distinct new catalyst, verdict new.";

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
	const model = GROK_WHY_MODEL;
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
		text: { format: GROK_WHY_TEXT_FORMAT },
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

		const obj = parseResponsesJsonObject(data);
		if (!obj || !isWhyVerdict(obj.verdict) || typeof obj.why !== "string") {
			rootLogger.warn("Price-move why Grok JSON parse failed; fail-open omit", {
				action: "price_move_why",
				symbol: options.symbol,
			});
			return null;
		}

		const parsedVerdict = obj.verdict;
		const cleaned = applyAnnotationsInline(obj.why, collectMessageAnnotations(data)).replace(
			/\*\*([^*\n]+)\*\*/g,
			"$1",
		);
		const body = cleaned.trim();
		const verdict: PriceMoveWhyVerdict = hadPrior ? parsedVerdict : "new";
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
