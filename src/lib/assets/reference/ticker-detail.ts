import { requireEnv } from "../../db/env";
import { isRecord } from "../../types";
import { marketDataFetch } from "../../vendors/massive";
import type { TickerDetail } from "../types";
import { ALLOWED_LOGO_HOSTS, MASSIVE_TICKERS_PATH_PREFIX } from "./constants";

/**
 * Fetch the logo URL for a single ticker from Massive's ticker-detail endpoint.
 *
 * `ok: false` means the answer is not definitive (transport failure, or a payload
 * whose shape drifted) — leave the row unchecked so a later run retries. `ok: true,
 * iconUrl: null` means Massive returned a `results` object with no branding icon.
 */
export async function fetchTickerDetail(symbol: string): Promise<TickerDetail> {
	const data = await marketDataFetch(
		`${MASSIVE_TICKERS_PATH_PREFIX}/${encodeURIComponent(symbol)}`,
		{},
		"ticker-details",
		{ symbol },
	);
	if (!isRecord(data)) {
		return { ok: false };
	}

	const results = data.results;
	if (!isRecord(results)) {
		return { ok: false };
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
