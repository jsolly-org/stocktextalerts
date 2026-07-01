import { setTimeout as realDelay } from "node:timers/promises";
import { requireEnv } from "../db/env";
import { rootLogger } from "../logging";
import {
	FINNHUB_BASE_URL,
	VENDOR_FETCH_MAX_RETRIES as MAX_RETRIES,
	OPTIONAL_VENDOR_DEGRADED_CATEGORY,
	VENDOR_FETCH_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
	VENDOR_FETCH_RETRY_DELAY_MS as RETRY_DELAY_MS,
} from "./constants";
import type { FinnhubFetchPolicy } from "./types";

/** Read the Finnhub API key from env. Throws if not set. */
function getFinnhubApiKey(): string {
	return requireEnv("FINNHUB_API_KEY");
}

/** Parse `Retry-After` into a delay (ms), or `null` when missing/unparseable. */
function parseRetryAfterMs(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1_000;
	}
	const date = Date.parse(headerValue);
	if (Number.isFinite(date)) {
		const delayMs = date - Date.now();
		return delayMs > 0 ? delayMs : 0;
	}
	return null;
}

/** Redact the Finnhub `token=` query param from loggable strings. */
function redactFinnhubToken(value: string): string {
	return value.replace(/([?&]token=)[^&]+/gi, "$1[redacted]");
}

/** Compute retry delay with exponential backoff and jitter (respects Retry-After). */
function computeRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
	if (retryAfterMs !== null) {
		// Cap Retry-After at 60 s to avoid excessively long waits.
		return Math.min(retryAfterMs, 60_000);
	}
	const base = RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * base * 0.5;
	return base + jitter;
}

type FinnhubFailure =
	| { reason: "rate_limited"; status: 429 }
	| { reason: "api_error"; status: number; bodyPreview?: string }
	| { reason: "timeout"; error: Error }
	| { reason: "request_failed"; error: Error };

/** Low-level Finnhub fetch wrapper with retries, timeouts, and rate-limit handling. */
export async function finnhubFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
	policy?: FinnhubFetchPolicy,
): Promise<unknown> {
	const optional = policy?.optional === true;
	const failureCategory = optional ? OPTIONAL_VENDOR_DEGRADED_CATEGORY : "vendor_retry_exhausted";
	const apiKey = getFinnhubApiKey();

	const query = new URLSearchParams({ ...params, token: apiKey });
	const url = `${FINNHUB_BASE_URL}${endpoint}?${query.toString()}`;

	// Per-attempt failures are silent. Only terminal exhaustion is logged:
	// rate-limit exhaustion at info (expected on free tier), other failures
	// at error (genuine outage).
	let lastFailure: FinnhubFailure | null = null;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;

		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (response.status === 429) {
				lastFailure = { reason: "rate_limited", status: 429 };
				if (!isLastAttempt) {
					const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
					await realDelay(computeRetryDelayMs(attempt, retryAfterMs));
					continue;
				}
				break;
			}

			if (!response.ok) {
				let bodyPreview: string | undefined;
				if (isLastAttempt) {
					try {
						const text = await response.text();
						bodyPreview = text.slice(0, 500);
					} catch {
						bodyPreview = undefined;
					}
				}
				lastFailure = { reason: "api_error", status: response.status, bodyPreview };
				if (!isLastAttempt) {
					await realDelay(computeRetryDelayMs(attempt, null));
					continue;
				}
				break;
			}

			return (await response.json()) as unknown;
		} catch (error) {
			const isTimeout =
				error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			const safeError =
				error instanceof Error
					? (() => {
							const sanitized = new Error(redactFinnhubToken(error.message));
							sanitized.name = error.name;
							if (error.stack) {
								sanitized.stack = redactFinnhubToken(error.stack);
							}
							return sanitized;
						})()
					: new Error(redactFinnhubToken(String(error)));
			lastFailure = isTimeout
				? { reason: "timeout", error: safeError }
				: { reason: "request_failed", error: safeError };
			if (!isLastAttempt) {
				await realDelay(computeRetryDelayMs(attempt, null));
				continue;
			}
			break;
		}
	}

	if (lastFailure) {
		const context: Record<string, unknown> = {
			endpoint,
			paramKeys: Object.keys(params),
			attempts: MAX_RETRIES,
			reason: lastFailure.reason,
		};
		if (lastFailure.reason === "rate_limited") {
			context.status = lastFailure.status;
			// Rate-limit exhaustion is an expected operational reality on
			// Finnhub's free tier — not pageable. Terminal state, no further
			// retry, so info (not warn) per project rule that warn requires
			// an escalation path.
			rootLogger.info(`Finnhub ${label} exhausted retries (rate limited)`, context);
		} else if (lastFailure.reason === "api_error") {
			context.status = lastFailure.status;
			if (lastFailure.bodyPreview) {
				context.bodyPreview = lastFailure.bodyPreview;
			}
			context.category = failureCategory;
			const logFn = optional ? rootLogger.warn.bind(rootLogger) : rootLogger.error.bind(rootLogger);
			logFn(
				`Finnhub ${label} exhausted retries`,
				context,
				new Error(`Finnhub HTTP ${lastFailure.status}`),
			);
		} else {
			context.category = failureCategory;
			if (optional) {
				rootLogger.warn(`Finnhub ${label} exhausted retries`, context);
			} else {
				rootLogger.error(`Finnhub ${label} exhausted retries`, context, lastFailure.error);
			}
		}
	}
	return null;
}
