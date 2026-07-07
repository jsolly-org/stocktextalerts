import { requireEnv } from "../../db/env";
import { isRecord } from "../../types";
import { finnhubFetch } from "../../vendors/finnhub";
import type { TickerDetail } from "../types";
import { ALLOWED_LOGO_HOSTS, MASSIVE_LOGO_HOST } from "./constants";

/**
 * Fetch the logo URL for a single ticker from Finnhub `/stock/profile2` (free tier).
 *
 * `ok: false` means the answer is not definitive (transport failure, or a payload
 * whose shape drifted) — leave the row unchecked so a later run retries. `ok: true,
 * iconUrl: null` means Finnhub definitively has no logo: either `{}` (unknown
 * symbol) or a profile whose `logo` is empty. A NON-empty payload missing the
 * `logo` key entirely is treated as shape drift, not definitive-none — otherwise a
 * vendor field rename would durably stamp "no logo" across the whole drip.
 */
export async function fetchTickerDetail(symbol: string): Promise<TickerDetail> {
	const data = await finnhubFetch("/stock/profile2", { symbol }, "company-profile", {
		optional: true,
	});
	if (!isRecord(data)) {
		return { ok: false };
	}
	if (Object.keys(data).length > 0 && !("logo" in data)) {
		return { ok: false };
	}
	const logo = typeof data.logo === "string" ? data.logo.trim() : "";
	return { ok: true, iconUrl: logo !== "" ? logo : null };
}

/**
 * True when `iconUrl` is an https URL on an allowed logo host with no explicit
 * port — the storable/fetchable shape. Write-time gate for the icon backfill and
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
 * DB-sourced). Massive-era URLs get the API key appended server-side; Finnhub CDN
 * URLs are public and pass through untouched. Shared by the dashboard logo proxy and
 * the email logo fetcher so the allowlist can't drift between them.
 */
export function resolveLogoUpstreamUrl(iconUrl: string): string | null {
	if (!isAllowedLogoUrl(iconUrl)) {
		return null;
	}
	const parsed = new URL(iconUrl);
	if (parsed.hostname === MASSIVE_LOGO_HOST) {
		parsed.searchParams.set("apiKey", requireEnv("MASSIVE_API_KEY"));
	}
	return parsed.toString();
}
