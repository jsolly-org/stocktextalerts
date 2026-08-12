import { setTimeout as realDelay } from "node:timers/promises";
import { readEnv } from "../db/env";
import { rootLogger } from "../logging";
import type { XaiAnnotation } from "./grok-citations";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "./optional-vendors";

const BASE_RETRY_DELAY_MS = 1_000;

/**
 * Process-local short-circuit after a non-retriable auth/credits failure.
 * Nightly PM discovery can hit dozens of symbols; retrying 403 three times each
 * burns Lambda wall-clock without recovering.
 */
let grokAuthExhaustedThisProcess = false;

/**
 * Exponential backoff helper for Grok retries.
 *
 * Uses `node:timers/promises` so delays work even when vitest's
 * `vi.useFakeTimers()` has replaced the global `setTimeout`.
 */
const delay = (attempt: number) => realDelay(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));

/**
 * Clear the process-local Grok auth short-circuit. Called from `runLambda` at
 * the start of every invoke so a warm container does not skip Grok forever
 * after one 401/403. Tests also call this between cases.
 */
export function resetGrokAuthExhausted(): void {
	grokAuthExhaustedThisProcess = false;
}

/** Responses API structured-output format (flattened under `text.format`). */
export type GrokTextFormat = {
	type: "json_schema";
	name: string;
	strict: true;
	schema: {
		type: "object";
		properties: Record<string, unknown>;
		required: readonly string[];
		additionalProperties: false;
	};
};

export type GrokResponsesRequest = {
	model: string;
	input: string;
	instructions: string;
	temperature?: number;
	max_output_tokens?: number;
	reasoning_effort?: "none" | "low" | "medium" | "high";
	tools?: Array<{ type: "web_search" | "x_search" }>;
	include?: string[];
	text?: { format: GrokTextFormat };
};

export type GrokResponsesResponse = {
	id: string;
	object: "response" | (string & {});
	created_at: number;
	model: string;
	status: string;
	output_text?: string;
	output: Array<{
		id?: string;
		type?: string;
		role?: string;
		status?: string;
		content?: Array<{
			type?: string;
			text?: string;
			annotations?: XaiAnnotation[];
		}>;
		summary?: Array<{ type?: string; text?: string }>;
		[key: string]: unknown;
	}>;
};

/**
 * Prefer `output_text`; else only assistant `message` items (never tool-call chunks).
 */
function extractResponsesOutputText(response: GrokResponsesResponse): string | null {
	if (typeof response.output_text === "string" && response.output_text.trim()) {
		return response.output_text.trim();
	}
	const texts: string[] = [];
	for (const item of response.output ?? []) {
		if (item.type !== undefined && item.type !== "message") continue;
		if (!Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (part.type !== "output_text" && part.type !== "text") continue;
			if (typeof part.text === "string" && part.text.trim()) {
				texts.push(part.text.trim());
			}
		}
	}
	const joined = texts.join("\n").trim();
	return joined === "" ? null : joined;
}

/**
 * Parse schema-constrained JSON object from Responses `output_text`.
 * Returns null on empty or invalid JSON (caller fail-opens).
 */
export function parseResponsesJsonObject(
	response: GrokResponsesResponse,
): Record<string, unknown> | null {
	const text = extractResponsesOutputText(response);
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Per-attempt timeouts for Grok API calls (escalating).
 *
 * Total worst-case across all attempts (including backoff delays):
 * 30s + 1s + 45s + 2s + 60s = 138s.
 */
const GROK_TIMEOUT_BY_ATTEMPT_MS = [30_000, 45_000, 60_000] as const;

/**
 * Call the xAI Responses API with retry logic.
 *
 * Returns the parsed JSON response on success, `null` on failure after retries.
 */
export async function fetchGrokResponse(options: {
	requestBody: GrokResponsesRequest;
	logContext: Record<string, unknown>;
}): Promise<GrokResponsesResponse | null> {
	const apiKey = readEnv("XAI_API_KEY");
	if (!apiKey || apiKey.trim() === "") {
		rootLogger.warn("XAI_API_KEY is not set; skipping Grok call", {
			...options.logContext,
			reason: "missing_api_key",
		});
		return null;
	}

	if (grokAuthExhaustedThisProcess) {
		rootLogger.warn("Skipping Grok — auth/credits exhausted earlier this process", {
			...options.logContext,
			reason: "auth_exhausted_this_process",
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
				// 401/403 (bad key, credits, spending limit) never recover on retry.
				if (response.status === 401 || response.status === 403) {
					grokAuthExhaustedThisProcess = true;
					rootLogger.warn("Grok auth/credits rejected — skipping further Grok calls", {
						...failureContext,
						category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
					});
					return null;
				}
				// Schema / request validation — never recovers on retry (avoid 30+45+60s burn).
				if (response.status === 400) {
					rootLogger.error("Grok request rejected (400 validation); not retrying", {
						...failureContext,
						category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
					});
					return null;
				}
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

			return (await response.json()) as GrokResponsesResponse;
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
