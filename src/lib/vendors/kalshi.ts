import { setTimeout as realDelay } from "node:timers/promises";
import { rootLogger } from "../logging";
import { createSlidingWindowLimiter } from "../rate-limit";
import {
	KALSHI_MAX_CALLS_PER_MINUTE,
	KALSHI_TRADE_API_BASE_URL,
	VENDOR_FETCH_MAX_RETRIES as MAX_RETRIES,
	PREDICTION_MARKET_USER_AGENT,
	VENDOR_FETCH_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
	VENDOR_FETCH_RETRY_DELAY_MS as RETRY_DELAY_MS,
} from "./constants";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "./optional-vendors";

const kalshiLimiter = createSlidingWindowLimiter({
	maxPerWindow: KALSHI_MAX_CALLS_PER_MINUTE,
	windowMs: 60_000,
});

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

export type KalshiFetchPolicy = {
	/** When true, terminal failures log as optional degradation (warn). */
	optional?: boolean;
};

/**
 * Low-level Kalshi Trade API fetch (public market data, no auth) with retries
 * and rate limiting. Returns `null` when the request ultimately fails.
 */
export async function kalshiFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
	policy?: KalshiFetchPolicy,
): Promise<unknown> {
	const optional = policy?.optional === true;
	const failureCategory = optional ? OPTIONAL_VENDOR_DEGRADED_CATEGORY : "vendor_retry_exhausted";

	const query = new URLSearchParams(params);
	const qs = query.toString();
	const url = `${KALSHI_TRADE_API_BASE_URL}${endpoint}${qs ? `?${qs}` : ""}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		await kalshiLimiter.acquire();

		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: { "User-Agent": PREDICTION_MARKET_USER_AGENT, Accept: "application/json" },
			});

			if (response.status === 429) {
				if (!isLastAttempt) {
					const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
					await realDelay(computeRetryDelayMs(attempt, retryAfterMs));
					continue;
				}
				rootLogger.info(`Kalshi ${label} exhausted retries (rate limited)`, {
					endpoint,
					attempts: MAX_RETRIES,
				});
				return null;
			}

			if (!response.ok) {
				if (!isLastAttempt) {
					await realDelay(computeRetryDelayMs(attempt, null));
					continue;
				}
				const context = {
					endpoint,
					status: response.status,
					attempts: MAX_RETRIES,
					category: failureCategory,
				};
				const err = new Error(`Kalshi HTTP ${response.status}`);
				if (optional) {
					rootLogger.warn(`Kalshi ${label} exhausted retries`, context);
				} else {
					rootLogger.error(`Kalshi ${label} exhausted retries`, context, err);
				}
				return null;
			}

			return (await response.json()) as unknown;
		} catch (error) {
			if (!isLastAttempt) {
				await realDelay(computeRetryDelayMs(attempt, null));
				continue;
			}
			const context = {
				endpoint,
				attempts: MAX_RETRIES,
				category: failureCategory,
			};
			if (optional) {
				rootLogger.warn(`Kalshi ${label} exhausted retries`, context);
			} else {
				rootLogger.error(
					`Kalshi ${label} exhausted retries`,
					context,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			return null;
		}
	}

	return null;
}
