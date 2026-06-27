/** Shared retry/timeout policy for third-party market-data HTTP (Finnhub, Massive). */

import { readEnv } from "../db/env";

export const VENDOR_FETCH_MAX_RETRIES = 3;
export const VENDOR_FETCH_RETRY_DELAY_MS = 2_000;
/** Per-attempt abort; Finnhub earnings/insider can exceed 10s under load. */
export const VENDOR_FETCH_REQUEST_TIMEOUT_MS = 25_000;

/**
 * Skip real vendor HTTP during E2E runs (dummy API keys in the test env).
 * Vitest keeps calling through to mocked `fetch`; only set
 * `SKIP_VENDOR_HTTP_IN_TEST=1` in the Playwright webServer environment.
 */
export function shouldSkipVendorHttpInTestMode(_provider: string): boolean {
	return readEnv("SKIP_VENDOR_HTTP_IN_TEST") === "1";
}
