/**
 * Outbound vendor HTTP boundary for code that does not go through
 * {@link file://./massive.ts} `marketDataFetch`.
 *
 * `astro.config.ts` swaps vendor modules for no-op stubs on `MODE=test` Astro servers
 * (E2E and the Vitest HTTP tests), which is how those suites avoid live provider calls.
 * The logo paths escaped that boundary: the dashboard proxy, the icon probe, and the
 * email logo fetcher each call `fetch` directly, so a `MODE=test` server still made live
 * requests to `api.massive.com` with the CI placeholder key (35 per E2E run, every one a
 * 401, plus icon-probe retries behind a 30s timeout). Routing them through one module
 * puts them back inside the stub boundary; see tests/stubs/vendors/http.ts.
 *
 * In production this is `fetch`. Keep it that way: the point of the seam is that the
 * swap happens in the build, not in a runtime branch.
 */
export async function vendorFetch(url: string, init?: RequestInit): Promise<Response> {
	return fetch(url, init);
}
