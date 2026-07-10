import { setTimeout as realDelay } from "node:timers/promises";
import { requireEnv } from "../db/env";
import { rootLogger } from "../logging";
import { createErrorForLogging } from "../logging/errors";
import { isRecord } from "../types";
import {
	VENDOR_FETCH_MAX_RETRIES as DEFAULT_MAX_RETRIES,
	VENDOR_FETCH_REQUEST_TIMEOUT_MS as DEFAULT_REQUEST_TIMEOUT_MS,
	MASSIVE_BASE_URL,
	VENDOR_FETCH_RETRY_DELAY_MS as RETRY_DELAY_MS,
} from "./constants";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "./optional-vendors";

function getMassiveApiKey(): string {
	return requireEnv("MASSIVE_API_KEY");
}

function computeRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
	if (retryAfterMs !== null) {
		return Math.min(retryAfterMs, 60_000);
	}
	const base = RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * base * 0.5;
	return base + jitter;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1_000;
	}
	return null;
}

/** Policy override for optional Massive routes (news, top movers, etc.). */
type MarketDataFetchPolicy = {
	maxRetries?: number;
	requestTimeoutMs?: number;
	/** When true, exhausted retries log as optional degradation (warn), not vendor_retry_exhausted. */
	optional?: boolean;
};

/**
 * Low-level Massive fetch wrapper with retries, rate-limit handling, and timeouts.
 *
 * Returns `null` when the request ultimately fails.
 */
export async function marketDataFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
	logContext?: Record<string, unknown>,
	policy?: MarketDataFetchPolicy,
): Promise<unknown> {
	const maxRetries = policy?.maxRetries ?? DEFAULT_MAX_RETRIES;
	const requestTimeoutMs = policy?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const optional = policy?.optional === true;
	const failureCategory = optional ? OPTIONAL_VENDOR_DEGRADED_CATEGORY : "vendor_retry_exhausted";

	const apiKey = getMassiveApiKey();

	const query = new URLSearchParams({ ...params, apiKey });
	const url = `${MASSIVE_BASE_URL}${endpoint}?${query.toString()}`;

	// Per-attempt failures log at warn (transient — next retry may recover).
	// Final-attempt failures: 429 stays info (rate limiting is expected, not
	// pageable). Non-429 errors and exception paths log at error AND tag the
	// context with `category: "vendor_retry_exhausted"` — these are excluded
	// from ErrorLogAlarm (via metric math) and feed per-Lambda vendor-retry
	// alarms instead, with cadence-appropriate thresholds (sustained for the
	// per-minute Schedule, single-occurrence for daily Lambdas). See
	// aws/template.yaml for the alarm split.
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const isLastAttempt = attempt === maxRetries;

		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(requestTimeoutMs),
			});

			if (response.status === 429) {
				const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
				const rateLimitContext = {
					endpoint,
					attempt,
					status: 429,
					...logContext,
				};
				if (!isLastAttempt) {
					rootLogger.warn(`Massive ${label} rate limited (429)`, rateLimitContext);
					await realDelay(computeRetryDelayMs(attempt, retryAfterMs));
					continue;
				}
				rootLogger.info(`Massive ${label} rate limited (429)`, rateLimitContext);
				return null;
			}

			if (!response.ok) {
				let apiStatus: string | null = null;
				let bodyPreview: string | undefined;
				try {
					const text = await response.text();
					if (isLastAttempt) {
						bodyPreview = text.slice(0, 500);
					}
					const payload: unknown = JSON.parse(text);
					if (isRecord(payload) && typeof payload.status === "string") {
						apiStatus = payload.status;
					}
				} catch {
					// Ignore malformed/non-JSON error bodies.
				}

				const apiErrorContext = {
					endpoint,
					attempt,
					status: response.status,
					apiStatus,
					...(bodyPreview ? { bodyPreview } : {}),
					...logContext,
				};
				if (isLastAttempt) {
					const logFn = optional
						? rootLogger.warn.bind(rootLogger)
						: rootLogger.error.bind(rootLogger);
					const statusDetail = apiStatus ? ` (${apiStatus})` : "";
					logFn(
						`Massive ${label} exhausted retries`,
						{ ...apiErrorContext, category: failureCategory },
						new Error(`Massive HTTP ${response.status}${statusDetail}`),
					);
					return null;
				}
				rootLogger.warn(`Massive ${label} API error`, apiErrorContext);
				await realDelay(computeRetryDelayMs(attempt, null));
				continue;
			}

			return await response.json();
		} catch (error) {
			const requestErrorContext = {
				endpoint,
				attempt,
				...logContext,
			};
			if (isLastAttempt) {
				if (optional) {
					rootLogger.warn(`Massive ${label} exhausted retries`, {
						...requestErrorContext,
						category: failureCategory,
					});
				} else {
					rootLogger.error(
						`Massive ${label} exhausted retries`,
						{ ...requestErrorContext, category: failureCategory },
						createErrorForLogging(error),
					);
				}
				return null;
			}
			rootLogger.warn(`Massive ${label} request failed`, requestErrorContext);
			await realDelay(computeRetryDelayMs(attempt, null));
		}
	}

	return null;
}
