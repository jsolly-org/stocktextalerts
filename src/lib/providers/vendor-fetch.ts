/** Shared retry/timeout policy for third-party market-data HTTP (Finnhub, Massive). */

import { readEnv } from "../db/env";

export const VENDOR_FETCH_MAX_RETRIES = 3;
export const VENDOR_FETCH_RETRY_DELAY_MS = 2_000;
/** Per-attempt abort; Finnhub earnings/insider can exceed 10s under load. */
export const VENDOR_FETCH_REQUEST_TIMEOUT_MS = 25_000;

/**
 * Upper bound for one `finnhubFetch` / `marketDataFetch` that exhausts all retries
 * (per-attempt timeouts + max exponential backoff, excluding Retry-After).
 */
function vendorFetchWorstCaseMs(): number {
	const attemptTimeouts = VENDOR_FETCH_MAX_RETRIES * VENDOR_FETCH_REQUEST_TIMEOUT_MS;
	let backoffTotal = 0;
	for (let attempt = 1; attempt < VENDOR_FETCH_MAX_RETRIES; attempt++) {
		// computeRetryDelayMs uses base * 2^(attempt-1) plus up to 50% jitter.
		backoffTotal += VENDOR_FETCH_RETRY_DELAY_MS * 2 ** (attempt - 1) * 1.5;
	}
	return attemptTimeouts + backoffTotal;
}

/** Vitest timeout for a single live call that may exhaust vendor retries. */
export function vendorFetchLiveTestTimeoutMs(): number {
	return vendorFetchWorstCaseMs() + 5_000;
}

/** True when `npm test -- --live=<provider>` or `TEST_LIVE_PROVIDERS` includes the provider. */
export function isLiveProviderEnabledInTests(provider: string): boolean {
	const enabled = process.env.LIVE_API_PROVIDERS ?? process.env.TEST_LIVE_PROVIDERS ?? "";
	if (!enabled) return false;
	return enabled
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.includes(provider.trim().toLowerCase());
}

/**
 * Skip real vendor HTTP during E2E runs (dummy API keys in the test env).
 * Vitest keeps calling through to mocked `fetch`; only set
 * `SKIP_VENDOR_HTTP_IN_TEST=1` in the Playwright webServer environment.
 */
export function shouldSkipVendorHttpInTestMode(_provider: string): boolean {
	return readEnv("SKIP_VENDOR_HTTP_IN_TEST") === "1";
}
