/** No-op vendor HTTP module for MODE=test Astro servers (E2E / HTTP tests). */

/**
 * Every vendor request resolves to an unavailable upstream, without touching the network.
 *
 * 503 rather than a canned success on purpose: it is what CI already observed (a 401 from
 * `api.massive.com`, since the test key is a placeholder), so callers take the exact same
 * "vendor unavailable" branch they take today and no spec changes meaning. Serving real
 * logo bytes here would newly exercise the success path, which is a deliberate coverage
 * change, not a side effect of taking the suite offline.
 */
export async function vendorFetch(_url: string, _init?: RequestInit): Promise<Response> {
	return new Response(null, {
		status: 503,
		statusText: "vendor http stubbed (MODE=test)",
	});
}
