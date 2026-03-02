import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";

/** In-memory cache of fetched logo base64 data URIs (or null on failure). */
export type LogoCache = Map<string, string | null>;

/** Create a fresh logo cache for a scheduler run. */
export function createLogoCache(): LogoCache {
	return new Map();
}

const FETCH_TIMEOUT_MS = 5000;
const PREFETCH_CONCURRENCY = 5;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
]);

/**
 * Fetch a single asset logo from the Massive API and return a base64 data URI.
 * Returns null on failure. Does NOT check DB or in-memory cache — callers
 * should use {@link fetchLogoBase64} which handles both caches.
 */
async function fetchLogoFromApi(iconUrl: string): Promise<string | null> {
	const parsed = new URL(iconUrl);
	if (parsed.hostname !== "api.massive.com" || parsed.protocol !== "https:") {
		return null;
	}

	const apiKey = import.meta.env.MASSIVE_API_KEY;
	if (apiKey) {
		parsed.searchParams.set("apiKey", apiKey);
	}

	const response = await fetch(parsed.toString(), {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (!response.ok) {
		return null;
	}

	const rawContentType = response.headers.get("content-type") ?? "image/png";
	const contentType =
		rawContentType.split(";")[0]?.trim().toLowerCase() || "image/png";
	if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
		return null;
	}
	const arrayBuffer = await response.arrayBuffer();
	const base64 = Buffer.from(arrayBuffer).toString("base64");
	return `data:${contentType};base64,${base64}`;
}

/**
 * Persist a fetched base64 logo to the `assets.icon_base64` column so
 * subsequent scheduler runs skip the API call entirely.
 */
async function persistLogoToDb(
	symbol: string,
	dataUri: string,
	supabase: AppSupabaseClient,
): Promise<void> {
	const { error } = await supabase
		.from("assets")
		.update({ icon_base64: dataUri })
		.eq("symbol", symbol);

	if (error) {
		rootLogger.warn("Failed to persist logo base64 to DB", {
			symbol,
			error: error.message,
		});
	}
}

/**
 * Get a logo base64 data URI for an asset, checking (in order):
 * 1. In-memory cache (per scheduler run)
 * 2. DB column `icon_base64` (persisted across runs)
 * 3. Massive API fetch (then persisted to DB for next time)
 *
 * Returns null if the logo is unavailable.
 */
export async function fetchLogoBase64(
	symbol: string,
	iconUrl: string | null | undefined,
	cache: LogoCache,
	iconBase64?: string | null,
	supabase?: AppSupabaseClient,
): Promise<string | null> {
	if (cache.has(symbol)) {
		return cache.get(symbol) ?? null;
	}

	// Use DB-cached base64 if available
	if (iconBase64) {
		cache.set(symbol, iconBase64);
		return iconBase64;
	}

	if (!iconUrl) {
		cache.set(symbol, null);
		return null;
	}

	try {
		const dataUri = await fetchLogoFromApi(iconUrl);
		cache.set(symbol, dataUri);

		// Persist to DB for future runs
		if (dataUri && supabase) {
			await persistLogoToDb(symbol, dataUri, supabase);
		}

		return dataUri;
	} catch (error) {
		rootLogger.warn("Failed to fetch logo for asset", {
			symbol,
			error: error instanceof Error ? error.message : String(error),
		});
		cache.set(symbol, null);
		return null;
	}
}

/**
 * Batch-prefetch logos for multiple assets with bounded concurrency.
 * Checks DB-cached `icon_base64` first; only fetches from API when missing.
 */
export async function prefetchLogos(
	assets: Array<{
		symbol: string;
		icon_url?: string | null;
		icon_base64?: string | null;
	}>,
	cache: LogoCache,
	supabase?: AppSupabaseClient,
): Promise<void> {
	const seen = new Set<string>();
	const uncached = assets.filter((a) => {
		if (cache.has(a.symbol) || seen.has(a.symbol)) return false;
		seen.add(a.symbol);
		return true;
	});
	for (let i = 0; i < uncached.length; i += PREFETCH_CONCURRENCY) {
		const batch = uncached.slice(i, i + PREFETCH_CONCURRENCY);
		await Promise.all(
			batch.map((a) =>
				fetchLogoBase64(a.symbol, a.icon_url, cache, a.icon_base64, supabase),
			),
		);
	}
}

const SAFE_IMAGE_DATA_URI =
	/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/** Render an inline `<img>` tag for a base64-encoded logo. */
export function renderLogoImg(base64DataUri: string): string {
	if (!SAFE_IMAGE_DATA_URI.test(base64DataUri)) {
		return "";
	}
	return `<img src="${base64DataUri}" alt="" width="20" height="20" style="vertical-align: middle; border-radius: 4px; margin-right: 4px;" />`;
}
