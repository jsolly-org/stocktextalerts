/**
 * Vendor HTTP stub that fails every request, for specs that want the
 * "vendor unavailable" branch specifically.
 *
 * Split out from {@link file://./http.ts}, which serves real PNG bytes for logo URLs so
 * E2E covers the dashboard proxy's success path. Unit specs whose pipelines prefetch
 * email logos want the opposite: no logo, no `assets.icon_base64` write on shared rows,
 * and no dependence on whether the seeded row happens to carry an `icon_url`. Point
 * those at this module so the intent is in the import, not in a shared stub's current
 * behavior.
 */
export async function vendorFetch(_url: string, _init?: RequestInit): Promise<Response> {
	return new Response(null, {
		status: 503,
		statusText: "vendor http stubbed unavailable (MODE=test)",
	});
}
