import { requireEnv } from "../db/env";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { extractErrorMessage } from "../logging/errors";

/** In-memory cache of fetched logo base64 data URIs (or null on failure). */
type LogoCache = Map<string, string | null>;

/** Create a fresh logo cache for a scheduler run. */
export function createLogoCache(): LogoCache {
	return new Map();
}

/** In-flight fetch promises keyed by symbol to de-duplicate concurrent requests. */
const inFlight = new Map<string, Promise<string | null>>();

const FETCH_TIMEOUT_MS = 5000;
const PREFETCH_CONCURRENCY = 5;
const MAX_LOGO_BYTES = 100 * 1024; // 100KB upper bound for inline email logos
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

	const apiKey = requireEnv("MASSIVE_API_KEY");
	parsed.searchParams.set("apiKey", apiKey);

	const response = await fetch(parsed.toString(), {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (!response.ok) {
		return null;
	}

	const contentLengthHeader = response.headers.get("content-length");
	if (contentLengthHeader) {
		const contentLength = Number(contentLengthHeader);
		if (Number.isFinite(contentLength) && contentLength > MAX_LOGO_BYTES) {
			return null;
		}
	}

	const rawContentType = response.headers.get("content-type") ?? "image/png";
	const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() || "image/png";
	if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
		return null;
	}
	const arrayBuffer = await response.arrayBuffer();
	if (arrayBuffer.byteLength > MAX_LOGO_BYTES) {
		return null;
	}
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
		rootLogger.error("Failed to persist logo base64 to DB", {
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
		const cached = cache.get(symbol) ?? null;
		// Allow retry when a prior call cached null without a usable URL.
		if (cached !== null || !iconUrl) {
			return cached;
		}
	}

	// Use DB-cached base64 only if it is a safe image data URI
	if (iconBase64 && SAFE_IMAGE_DATA_URI.test(iconBase64)) {
		cache.set(symbol, iconBase64);
		return iconBase64;
	}
	if (iconBase64) {
		rootLogger.error("Ignoring invalid DB-cached logo data URI", { symbol });
	}

	if (!iconUrl) {
		cache.set(symbol, null);
		return null;
	}

	const inFlightKey = `${symbol}::${iconUrl}`;
	let promise = inFlight.get(inFlightKey);
	if (!promise) {
		promise = (async (): Promise<string | null> => {
			try {
				const dataUri = await fetchLogoFromApi(iconUrl);
				cache.set(symbol, dataUri);

				// Persist to DB for future runs
				if (dataUri && supabase) {
					await persistLogoToDb(symbol, dataUri, supabase);
				}

				return dataUri;
			} catch (error) {
				rootLogger.error("Failed to fetch logo for asset", {
					symbol,
					error: extractErrorMessage(error),
				});
				cache.set(symbol, null);
				return null;
			} finally {
				inFlight.delete(inFlightKey);
			}
		})();
		inFlight.set(inFlightKey, promise);
	}

	// Ensure this caller's cache is populated when the shared promise resolves
	return promise.then((dataUri) => {
		cache.set(symbol, dataUri);
		return dataUri;
	});
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
			batch.map((a) => fetchLogoBase64(a.symbol, a.icon_url, cache, a.icon_base64, supabase)),
		);
	}
}

const SAFE_IMAGE_DATA_URI =
	/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/** Create a callback that maps symbol → `<img>` HTML from a logo cache. */
function createLogoHtmlGetter(cache: LogoCache): (symbol: string) => string | undefined {
	return (symbol) => {
		const dataUri = cache.get(symbol);
		return dataUri ? renderLogoImg(dataUri) : undefined;
	};
}

/** Render an inline `<img>` tag for a base64-encoded logo. */
export function renderLogoImg(base64DataUri: string): string {
	if (!SAFE_IMAGE_DATA_URI.test(base64DataUri)) {
		return "";
	}
	return `<img src="${base64DataUri}" alt="" width="20" height="20" style="vertical-align: middle; border-radius: 4px; margin-right: 4px;" />`;
}

/**
 * Encapsulates the repeated createLogoCache → try { prefetchLogos } catch { warn } → createLogoHtmlGetter pattern.
 * When `shouldPrefetch` is false, returns a getter backed by an empty cache.
 */
export async function safePrefetchLogos(options: {
	assets: Array<{
		symbol: string;
		icon_url?: string | null;
		icon_base64?: string | null;
	}>;
	shouldPrefetch: boolean;
	supabase?: AppSupabaseClient;
	logger: { error: (msg: string, meta: Record<string, unknown>) => void };
	logContext: Record<string, unknown>;
}): Promise<{
	cache: LogoCache;
	getLogoHtml: (symbol: string) => string | undefined;
}> {
	const cache = createLogoCache();
	if (options.shouldPrefetch) {
		try {
			await prefetchLogos(options.assets, cache, options.supabase);
		} catch (error) {
			options.logger.error("Failed to prefetch logos", {
				...options.logContext,
				assetCount: options.assets.length,
				error: extractErrorMessage(error),
			});
		}
	}
	return { cache, getLogoHtml: createLogoHtmlGetter(cache) };
}
