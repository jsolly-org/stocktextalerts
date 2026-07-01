import { setTimeout as realDelay } from "node:timers/promises";
import { readEnv } from "../db/env";
import { rootLogger } from "../logging";
import type { GrokResponsesRequest, GrokResponsesResponse } from "./types";

const BASE_RETRY_DELAY_MS = 1_000;

/**
 * Exponential backoff helper for Grok retries.
 *
 * Uses `node:timers/promises` so delays work even when vitest's
 * `vi.useFakeTimers()` has replaced the global `setTimeout`.
 */
const delay = (attempt: number) => realDelay(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));

/**
 * Per-attempt timeouts for Grok API calls (escalating).
 *
 * Total worst-case across all attempts (including backoff delays):
 * 30s + 1s + 45s + 2s + 60s = 138s.
 */
const GROK_TIMEOUT_BY_ATTEMPT_MS = [30_000, 45_000, 60_000] as const;

/**
 * Timeout for a single-shot Grok call (`fetchGrokResponseOnce`, no retry).
 * A no-retry call gets the full 60s budget — there's no later attempt to fall
 * back on, so it can't afford to give up early. Independent of the escalation
 * array above; not derived from it.
 */
export const GROK_SINGLE_SHOT_TIMEOUT_MS = 60_000;

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

/** Single-attempt Grok Responses API call with a fixed timeout. */
export async function fetchGrokResponseOnce(options: {
	requestBody: GrokResponsesRequest;
	logContext: Record<string, unknown>;
	timeoutMs: number;
}): Promise<GrokResponsesResponse | null> {
	const apiKey = readEnv("XAI_API_KEY");
	if (!apiKey) {
		rootLogger.warn("XAI_API_KEY is not set; skipping Grok call", {
			...options.logContext,
			reason: "missing_api_key",
		});
		return null;
	}

	try {
		const response = await fetch("https://api.x.ai/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(options.requestBody),
			signal: AbortSignal.timeout(options.timeoutMs),
		});

		if (!response.ok) {
			const context = {
				...options.logContext,
				status: response.status,
			};
			if (response.status === 429) {
				rootLogger.info("Grok request rate limited", context);
			} else {
				rootLogger.error("Grok request failed", context, new Error(`Grok HTTP ${response.status}`));
			}
			return null;
		}

		return (await response.json()) as GrokResponsesResponse;
	} catch (error) {
		const isTimeout = error instanceof Error && error.name === "TimeoutError";
		rootLogger.error(
			"Grok request errored",
			{
				...options.logContext,
				reason: isTimeout ? "timeout" : "request_failed",
			},
			error,
		);
		return null;
	}
}
