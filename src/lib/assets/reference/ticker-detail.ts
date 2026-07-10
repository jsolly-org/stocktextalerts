import { requireEnv } from "../../db/env";
import { isRecord } from "../../types";
import type { TickerDetail } from "../types";
import { ALLOWED_LOGO_HOSTS, MASSIVE_TICKERS_PATH_PREFIX } from "./constants";

const MASSIVE_BASE_URL = "https://api.massive.com";

/**
 * Fetch the logo URL for a single ticker from Massive's ticker-detail endpoint.
 *
 * Status-aware (not opaque `marketDataFetch` null) so:
 * - HTTP 404 → definitive no branding (`ok: true, iconUrl: null`) — stamp checked
 * - HTTP 200 with empty branding → same
 * - 429/5xx/network → `ok: false` — leave unchecked for retry
 */
export async function fetchTickerDetail(symbol: string): Promise<TickerDetail> {
	const apiKey = requireEnv("MASSIVE_API_KEY");
	const url = `${MASSIVE_BASE_URL}${MASSIVE_TICKERS_PATH_PREFIX}/${encodeURIComponent(symbol)}?apiKey=${apiKey}`;

	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	} catch {
		return { ok: false };
	}

	// Listed tickers occasionally 404 on the details route (Massive list/detail lag).
	if (response.status === 404) {
		return { ok: true, iconUrl: null };
	}
	if (!response.ok) {
		return { ok: false };
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		return { ok: false };
	}

	if (!isRecord(data)) {
		return { ok: false };
	}

	const results = data.results;
	if (!isRecord(results)) {
		// Empty/malformed results on 200 — treat as definitive no branding.
		return { ok: true, iconUrl: null };
	}

	const branding = results.branding;
	const iconUrl =
		isRecord(branding) && typeof branding.icon_url === "string" && branding.icon_url.trim() !== ""
			? branding.icon_url
			: null;
	return { ok: true, iconUrl };
}

/**
 * True when `iconUrl` is an https URL on an allowed logo host with no explicit
 * port — the storable/fetchable shape. Write-time gate for icon probes and
 * the first half of {@link resolveLogoUpstreamUrl}.
 */
export function isAllowedLogoUrl(iconUrl: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(iconUrl);
	} catch {
		return false;
	}
	return (
		parsed.protocol === "https:" && parsed.port === "" && ALLOWED_LOGO_HOSTS.has(parsed.hostname)
	);
}

/**
 * Resolve a stored `assets.icon_url` to the URL to actually fetch, or `null` when the
 * value is not an https URL on an allowed logo host (SSRF guard — icon_url is
 * DB-sourced). Massive branding URLs get the API key appended server-side.
 * Shared by the dashboard logo proxy and the email logo fetcher so the allowlist
 * can't drift between them.
 */
export function resolveLogoUpstreamUrl(iconUrl: string): string | null {
	if (!isAllowedLogoUrl(iconUrl)) {
		return null;
	}
	const parsed = new URL(iconUrl);
	parsed.searchParams.set("apiKey", requireEnv("MASSIVE_API_KEY"));
	return parsed.toString();
}
