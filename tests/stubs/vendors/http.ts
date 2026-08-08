/** No-op vendor HTTP module for MODE=test Astro servers (E2E / HTTP tests). */

import { MASSIVE_TICKERS_PATH_PREFIX } from "../../../src/lib/assets/reference/constants";

/**
 * A real, decodable 1x1 PNG (70 bytes).
 *
 * `AssetBadge.vue` falls back to the "Stock" pill whenever the `<img>` fails to decode
 * (`naturalWidth === 0`), so magic bytes alone would still render the fallback and the
 * success path would stay untested. This is small enough to sit under `MAX_LOGO_BYTES`
 * (100 KB) with room to spare, and inline base64 keeps the fixture reviewable in the
 * diff rather than adding the repo's only binary test asset.
 */
const ONE_PIXEL_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function onePixelPng(): ArrayBuffer {
	const binary = atob(ONE_PIXEL_PNG_BASE64);
	const buffer = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return buffer;
}

/** True for the Massive ticker-detail probe, which expects JSON rather than image bytes. */
function isTickerDetailUrl(url: string): boolean {
	try {
		return new URL(url).pathname.startsWith(MASSIVE_TICKERS_PATH_PREFIX);
	} catch {
		return false;
	}
}

/**
 * Resolve vendor requests without touching the network.
 *
 * Logo/branding fetches get real PNG bytes so the dashboard proxy
 * (`/api/assets/logo/:symbol`) and the email logo fetcher run their success paths:
 * content-type allowlist, `MAX_LOGO_BYTES` check, and the base64 data-URI inlining.
 * Against the old blanket 503 both collapsed to their "vendor unavailable" branch, so
 * the only logo behavior E2E covered was the fallback, at the cost of 35
 * `Upstream icon fetch failed` error logs per run.
 *
 * The ticker-detail probe deliberately stays 503. It is the same seam but a JSON
 * endpoint, and a 200 would make `checkAndStoreIcon` write `icon_url` +
 * `icon_checked_at` mid-spec — clobbering the fixture values `dashboard-assets`
 * TC-BADGE-001 sets to drive the null-icon and off-allowlist branches. Soft-failing
 * the probe is what leaves those rows alone.
 */
export async function vendorFetch(url: string, _init?: RequestInit): Promise<Response> {
	if (isTickerDetailUrl(url)) {
		return new Response(null, {
			status: 503,
			statusText: "vendor http stubbed (MODE=test)",
		});
	}

	return new Response(onePixelPng(), {
		status: 200,
		headers: { "Content-Type": "image/png" },
	});
}
