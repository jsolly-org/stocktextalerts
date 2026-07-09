import { setTimeout as realDelay } from "node:timers/promises";
import { rootLogger } from "../logging";
import { createSlidingWindowLimiter } from "../rate-limit";
import {
	VENDOR_FETCH_MAX_RETRIES as MAX_RETRIES,
	POLYMARKET_GAMMA_BASE_URL,
	POLYMARKET_MAX_CALLS_PER_MINUTE,
	PREDICTION_MARKET_USER_AGENT,
	VENDOR_FETCH_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
	VENDOR_FETCH_RETRY_DELAY_MS as RETRY_DELAY_MS,
} from "./constants";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "./optional-vendors";

const polymarketLimiter = createSlidingWindowLimiter({
	maxPerWindow: POLYMARKET_MAX_CALLS_PER_MINUTE,
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

export type PolymarketFetchPolicy = {
	/** When true, terminal failures log as optional degradation (warn). */
	optional?: boolean;
};

/**
 * Low-level Polymarket Gamma fetch (public, no auth) with retries and rate limiting.
 * Returns `null` when the request ultimately fails.
 */
export async function polymarketFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
	policy?: PolymarketFetchPolicy,
): Promise<unknown> {
	const optional = policy?.optional === true;
	const failureCategory = optional ? OPTIONAL_VENDOR_DEGRADED_CATEGORY : "vendor_retry_exhausted";

	const query = new URLSearchParams(params);
	const qs = query.toString();
	const url = `${POLYMARKET_GAMMA_BASE_URL}${endpoint}${qs ? `?${qs}` : ""}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		await polymarketLimiter.acquire();

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
				rootLogger.info(`Polymarket ${label} exhausted retries (rate limited)`, {
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
				const err = new Error(`Polymarket HTTP ${response.status}`);
				if (optional) {
					rootLogger.warn(`Polymarket ${label} exhausted retries`, context);
				} else {
					rootLogger.error(`Polymarket ${label} exhausted retries`, context, err);
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
				rootLogger.warn(`Polymarket ${label} exhausted retries`, context);
			} else {
				rootLogger.error(
					`Polymarket ${label} exhausted retries`,
					context,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			return null;
		}
	}

	return null;
}
