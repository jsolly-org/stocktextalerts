import { PRICE_MOVE_ALERT_THRESHOLD_PERCENT } from "../../constants";
import { rootLogger } from "../../logging";
import type { IntradayBarsResult } from "../../types";
import {
	collectMessageAnnotations,
	type GrokResponsesRequest,
	type GrokTextFormat,
	parseResponsesJsonObject,
} from "../../vendors/grok";
import { applyAnnotationsInline } from "../../vendors/grok-citations";
import { GROK_WHY_MODEL } from "../../vendors/grok-models";
import { fetchGrokResponseWithClientTools } from "../../vendors/grok-tool-loop";
import { formatIdentitySearchBlock, identitySearchNames } from "./why-identity";
import { deriveMoveOnsetEt, moveWindowXSearchDates } from "./why-onset";
import { executeGetQuotes, GET_QUOTES_FUNCTION_TOOL, GET_QUOTES_MAX_ROUNDS } from "./why-quotes";

export type PriceMoveWhyVerdict = "same" | "updated" | "new" | "unknown";

export type PriceMoveWhyGrade = "confirmed" | "reported" | "narrative" | "sector" | "unexplained";

/** Every reason a price-move alert ships without a why lede. Logged verbatim as `reason`. */
const PRICE_MOVE_WHY_OMIT_REASONS = [
	"grok_null",
	"parse_failed",
	"no_tool_calls",
	"bars_failed",
	"empty_lede",
	"quote_loop_cap",
	"missing_key",
	"budget",
] as const;

export type PriceMoveWhyOmitReason = (typeof PRICE_MOVE_WHY_OMIT_REASONS)[number];

type PriceMoveWhyClaim = {
	text: string;
	source_url: string;
	publish_time: string;
};

type PriceMoveCatalystPacket = {
	lede: string;
	grade: PriceMoveWhyGrade;
	verdict: PriceMoveWhyVerdict;
	catalyst_type: string;
	event_date: string | null;
	key_entity: string | null;
	claims: PriceMoveWhyClaim[];
	move_onset: string;
	retrieval_version: string;
};

type PriceMoveWhySuccess = {
	ok: true;
	text: string;
	verdict: PriceMoveWhyVerdict;
	packet: PriceMoveCatalystPacket;
};

type PriceMoveWhyFailure = {
	ok: false;
	reason: PriceMoveWhyOmitReason;
};

type PriceMoveWhyOutcome = PriceMoveWhySuccess | PriceMoveWhyFailure;

const WHY_RETRIEVAL_VERSION = "why-toolkit-v1";

const UNKNOWN_TEXT = "No clear catalyst on the wire.";
const UNKNOWN_ACCEL_TEXT = "Still no clear catalyst on the wire.";

const PRICE_MOVE_WHY_GRADES = [
	"confirmed",
	"reported",
	"narrative",
	"sector",
	"unexplained",
] as const;

export const GROK_WHY_TEXT_FORMAT = {
	type: "json_schema",
	name: "price_move_why",
	strict: true,
	schema: {
		type: "object",
		properties: {
			lede: { type: "string" },
			grade: { type: "string", enum: [...PRICE_MOVE_WHY_GRADES] },
			catalyst_type: { type: "string" },
			event_date: { type: "string" },
			key_entity: { type: "string" },
			claims: {
				type: "array",
				items: {
					type: "object",
					properties: {
						text: { type: "string" },
						source_url: { type: "string" },
						publish_time: { type: "string" },
					},
					required: ["text", "source_url", "publish_time"],
					additionalProperties: false,
				},
			},
		},
		required: ["lede", "grade", "catalyst_type", "event_date", "key_entity", "claims"],
		additionalProperties: false,
	},
} as const satisfies GrokTextFormat;

function isWhyGrade(value: unknown): value is PriceMoveWhyGrade {
	return (
		typeof value === "string" && (PRICE_MOVE_WHY_GRADES as ReadonlyArray<string>).includes(value)
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

function normalizeEntity(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

export function classifyContinuityAfterSearch(options: {
	hadPrior: boolean;
	priorCatalystType: string | null;
	priorEventDate: string | null;
	priorKeyEntity: string | null;
	grade: PriceMoveWhyGrade;
	catalystType: string;
	eventDate: string | null;
	keyEntity: string | null;
}): PriceMoveWhyVerdict {
	if (options.grade === "unexplained") {
		return "unknown";
	}
	if (!options.hadPrior) {
		return "new";
	}
	const sameEntity =
		normalizeEntity(options.priorKeyEntity) !== "" &&
		normalizeEntity(options.priorKeyEntity) === normalizeEntity(options.keyEntity);
	const sameType =
		(options.priorCatalystType ?? "").trim().toLowerCase() ===
		options.catalystType.trim().toLowerCase();
	const sameDate = (options.priorEventDate ?? "") === (options.eventDate ?? "");
	if (sameEntity && sameType && sameDate) {
		return "same";
	}
	if (sameEntity) {
		return "updated";
	}
	return "new";
}

const GRADE_PREFIX_RE = new RegExp(
	`^\\s*[[(]?\\s*(?:grade\\s*[:=]\\s*)?(?:${PRICE_MOVE_WHY_GRADES.join("|")})\\s*[\\])]?\\s*[:\\-–—]\\s*`,
	"i",
);
const GRADE_ASIDE_RE = new RegExp(
	`\\s*[[(]\\s*grade\\s*[:=]\\s*(?:${PRICE_MOVE_WHY_GRADES.join("|")})\\s*[\\])]`,
	"gi",
);

/** Grades are internal routing, not reader copy — never let one leak into a rendered lede. */
function stripGradeTokens(text: string): string {
	let out = text.trim();
	for (let i = 0; i < PRICE_MOVE_WHY_GRADES.length; i++) {
		const next = out.replace(GRADE_PREFIX_RE, "").trim();
		if (next === out) break;
		out = next;
	}
	return out
		.replace(GRADE_ASIDE_RE, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function buildWhyPrompt(options: {
	symbol: string;
	companyName?: string;
	triggerPercent: number;
	isAcceleration: boolean;
	sessionPercent?: number | null;
	accelPercent?: number | null;
	identityNames: readonly string[];
	moveOnsetEt: string;
}): { system: string; user: string } {
	const {
		symbol,
		companyName,
		triggerPercent,
		isAcceleration,
		sessionPercent,
		accelPercent,
		identityNames,
		moveOnsetEt,
	} = options;
	const direction = triggerPercent >= 0 ? "up" : "down";
	const absPct = Math.abs(triggerPercent).toFixed(1);
	const name = companyName && companyName.trim() !== "" ? companyName.trim() : symbol;

	const system =
		"You explain short-term US equity price moves for alert notifications. " +
		"Be factual, neutral, and concise (1–2 sentences) in the lede. " +
		"Do not give buy/sell advice. " +
		"You must call BOTH web_search and x_search before concluding anything about a catalyst. " +
		"State each source's publish date. " +
		"A source published after the move began cannot be the cause unless it names a discrete event with its own earlier timestamp. " +
		"Cite claims with real URLs from search — never invent URLs. " +
		"Paraphrase; do not quote wire copy verbatim. " +
		"Ask x_search for the dominant theme in the window, not individually attributable posts. " +
		"After search, you may call get_quotes for symbols search already named — do not fish for peers. " +
		"Grade internally, and shape the lede to the grade you picked: " +
		"confirmed — an official announcement, filing, or earnings release before onset; name the actor and the act. " +
		"reported — credible press before onset without official confirmation; attribute the claim to the outlet. " +
		"narrative — analyst commentary or chatter with no discrete event; hedge the language. " +
		"sector — a group move with no idiosyncratic event; describe only what search and get_quotes actually found, " +
		"never a canned peer list and never symbols you did not look up. " +
		"unexplained — both searches ran and none of the above holds. " +
		"The grade belongs in the grade field only: never write a grade word or grade prefix in the lede. " +
		"Plain text in lede — no markdown bold/italic/headings/bullets beyond citation links.";

	const identityBlock = formatIdentitySearchBlock(identityNames);
	const sessionLine =
		sessionPercent !== undefined && sessionPercent !== null
			? `Session move vs previous close: ${sessionPercent.toFixed(1)}%.\n`
			: "";
	const accelLine =
		isAcceleration && accelPercent !== undefined && accelPercent !== null
			? `Additional move since last alert: ${accelPercent.toFixed(1)}%.\n`
			: "";
	const magnitudeLine = isAcceleration
		? `Configured first-print magnitude is ${PRICE_MOVE_ALERT_THRESHOLD_PERCENT}%; this continuation fires at half (${PRICE_MOVE_ALERT_THRESHOLD_PERCENT / 2}%).\n`
		: `Configured first-print / reverse magnitude is ${PRICE_MOVE_ALERT_THRESHOLD_PERCENT}%.\n`;
	const eventKind = isAcceleration
		? `This is an acceleration (same-direction continuation).\n${magnitudeLine}`
		: `This is a first print (or reverse-direction re-trigger).\n${magnitudeLine}`;

	const user =
		`Explain THIS move for ${symbol} (${name}): ${direction} ${absPct}%.\n` +
		eventKind +
		sessionLine +
		accelLine +
		`Move onset (when the tape actually moved): ${moveOnsetEt}.\n` +
		(identityBlock !== "" ? `${identityBlock}\n` : "") +
		"Prefer sources published at or before move onset. Demand a publish date for every cited source.\n" +
		"Return lede, grade, catalyst_type, event_date (YYYY-MM-DD or empty), key_entity, and claims via the structured schema.\n" +
		`If there is no clear catalyst after search, use grade unexplained and a short hedge like "${UNKNOWN_TEXT}".`;

	return { system, user };
}

function parseClaims(raw: unknown): PriceMoveWhyClaim[] {
	if (!Array.isArray(raw)) return [];
	const out: PriceMoveWhyClaim[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.text !== "string" || typeof rec.source_url !== "string") continue;
		out.push({
			text: rec.text.trim(),
			source_url: rec.source_url.trim(),
			publish_time: typeof rec.publish_time === "string" ? rec.publish_time.trim() : "",
		});
	}
	return out;
}

export type PriorWhyFields = {
	summary: string | null;
	verdict: PriceMoveWhyVerdict | null;
	grade: PriceMoveWhyGrade | null;
	catalystType: string | null;
	eventDate: string | null;
	keyEntity: string | null;
};

/**
 * Generate a catalyst packet + short lede for a price-move alert.
 * Fail-open: returns `{ ok: false, reason }` on any failure — never a fake hedge.
 */
export async function generatePriceMoveWhyWithGrok(options: {
	symbol: string;
	companyName?: string;
	triggerPercent: number;
	isAcceleration: boolean;
	sessionPercent?: number | null;
	accelPercent?: number | null;
	intraday: IntradayBarsResult;
	prior: PriorWhyFields | null;
	persistedAliases?: readonly string[] | null;
	requestId?: string;
}): Promise<PriceMoveWhyOutcome> {
	const moveOnsetEt = deriveMoveOnsetEt(options.intraday);
	if (!moveOnsetEt) {
		rootLogger.warn("Price-move why omitted: no move onset from bars", {
			action: "price_move_why",
			symbol: options.symbol,
			reason: "bars_failed",
		});
		return { ok: false, reason: "bars_failed" };
	}

	const hadPrior = Boolean(options.prior?.summary && options.prior.summary.trim() !== "");
	const identityNames = identitySearchNames({
		symbol: options.symbol,
		companyName: options.companyName ?? options.symbol,
		persistedAliases: options.persistedAliases,
	});
	const { from_date, to_date } = await moveWindowXSearchDates();
	const { system, user } = buildWhyPrompt({
		symbol: options.symbol,
		companyName: options.companyName,
		triggerPercent: options.triggerPercent,
		isAcceleration: options.isAcceleration,
		sessionPercent: options.sessionPercent,
		accelPercent: options.accelPercent,
		identityNames,
		moveOnsetEt,
	});

	const model = GROK_WHY_MODEL;
	const requestBody: GrokResponsesRequest = {
		model,
		instructions: system,
		input: user,
		temperature: 0.3,
		max_output_tokens: 1500,
		reasoning_effort: "low",
		tools: [
			{ type: "web_search" },
			{ type: "x_search", from_date, to_date },
			GET_QUOTES_FUNCTION_TOOL,
		],
		text: { format: GROK_WHY_TEXT_FORMAT },
	};

	try {
		const loop = await fetchGrokResponseWithClientTools({
			requestBody,
			logContext: {
				action: "price_move_why",
				model,
				symbol: options.symbol,
				requestId: options.requestId,
			},
			maxFunctionRounds: GET_QUOTES_MAX_ROUNDS,
			executeFunction: async (name, argsJson, ctx) => {
				if (name !== "get_quotes") {
					return { error: `unknown function: ${name}` };
				}
				if (!ctx.sawSearch) {
					return { error: "Call both web_search and x_search before get_quotes" };
				}
				return executeGetQuotes(argsJson);
			},
		});

		if (loop.hitRoundCap) {
			rootLogger.warn("Price-move why omitted: quote-loop cap without final message", {
				action: "price_move_why",
				symbol: options.symbol,
				reason: "quote_loop_cap",
			});
			return { ok: false, reason: "quote_loop_cap" };
		}
		if (!loop.response) {
			rootLogger.warn("Price-move why omitted: no Grok response", {
				action: "price_move_why",
				symbol: options.symbol,
				reason: "grok_null",
			});
			return { ok: false, reason: "grok_null" };
		}
		// Both searches are the floor for any verdict, hedge included: a lede built
		// on half the toolkit is a guess, and an omitted why beats a fabricated one.
		if (!loop.sawSearch) {
			rootLogger.warn("Price-move why omitted: web_search and x_search did not both run", {
				action: "price_move_why",
				symbol: options.symbol,
				reason: "no_tool_calls",
				sawWebSearch: loop.sawWebSearch,
				sawXSearch: loop.sawXSearch,
			});
			return { ok: false, reason: "no_tool_calls" };
		}

		const obj = parseResponsesJsonObject(loop.response);
		if (!obj || !isWhyGrade(obj.grade) || typeof obj.lede !== "string") {
			rootLogger.warn("Price-move why Grok JSON parse failed; omit why", {
				action: "price_move_why",
				symbol: options.symbol,
				reason: "parse_failed",
			});
			return { ok: false, reason: "parse_failed" };
		}

		const cleaned = applyAnnotationsInline(
			obj.lede,
			collectMessageAnnotations(loop.response),
		).replace(/\*\*([^*\n]+)\*\*/g, "$1");
		const lede = stripGradeTokens(cleaned);
		if (lede === "") {
			rootLogger.warn("Price-move why omitted: empty lede", {
				action: "price_move_why",
				symbol: options.symbol,
				reason: "empty_lede",
			});
			return { ok: false, reason: "empty_lede" };
		}

		const catalystType = typeof obj.catalyst_type === "string" ? obj.catalyst_type.trim() : "";
		const eventDateRaw = typeof obj.event_date === "string" ? obj.event_date.trim() : "";
		const eventDate = eventDateRaw === "" ? null : eventDateRaw;
		const keyEntityRaw = typeof obj.key_entity === "string" ? obj.key_entity.trim() : "";
		const keyEntity = keyEntityRaw === "" ? null : keyEntityRaw;
		const grade = obj.grade;
		const verdict = classifyContinuityAfterSearch({
			hadPrior,
			priorCatalystType: options.prior?.catalystType ?? null,
			priorEventDate: options.prior?.eventDate ?? null,
			priorKeyEntity: options.prior?.keyEntity ?? null,
			grade,
			catalystType,
			eventDate,
			keyEntity,
		});

		const hedgeLede = grade === "unexplained" ? UNKNOWN_TEXT : lede;
		const text = applyContinuityLeadIn(hedgeLede, verdict, options.isAcceleration, hadPrior);
		const finalVerdict: PriceMoveWhyVerdict =
			text === UNKNOWN_TEXT || text === UNKNOWN_ACCEL_TEXT ? "unknown" : verdict;

		const packet: PriceMoveCatalystPacket = {
			lede: text,
			grade,
			verdict: finalVerdict,
			catalyst_type: catalystType,
			event_date: eventDate,
			key_entity: keyEntity,
			claims: parseClaims(obj.claims),
			move_onset: moveOnsetEt,
			retrieval_version: WHY_RETRIEVAL_VERSION,
		};

		return { ok: true, text, verdict: finalVerdict, packet };
	} catch (error) {
		rootLogger.warn(
			"Price-move why Grok call failed open",
			{ action: "price_move_why", symbol: options.symbol, reason: "grok_null" },
			error,
		);
		return { ok: false, reason: "grok_null" };
	}
}
