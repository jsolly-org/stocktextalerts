import { SHORT_URL_TTL_DAYS } from "../../constants";
import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";

const SHORT_ID_LENGTH = 6;
const BASE62_CHARS =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_INSERT_ATTEMPTS = 3;

/** Generate a cryptographically random 6-char base62 ID. */
export function generateShortId(): string {
	const values = crypto.getRandomValues(new Uint8Array(SHORT_ID_LENGTH));
	let id = "";
	for (const byte of values) {
		id += BASE62_CHARS[byte % BASE62_CHARS.length];
	}
	return id;
}

/** Build the full short URL for a given ID. */
export function buildShortUrl(id: string): string {
	return new URL(`/r/${id}`, getSiteUrl()).toString();
}

/**
 * Shorten a single URL via Supabase. Deduplicates by original_url.
 * Falls back to the original URL on any DB error.
 */
export async function shortenUrl(
	url: string,
	supabase: AppSupabaseClient,
): Promise<string> {
	try {
		// Check for existing short URL (dedup)
		const { data: existing } = await supabase
			.from("short_urls")
			.select("id")
			.eq("original_url", url)
			.gt("expires_at", new Date().toISOString())
			.limit(1)
			.single();

		if (existing) {
			return buildShortUrl(existing.id);
		}

		// Insert with collision retry
		for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
			const id = generateShortId();
			const expiresAt = new Date(
				Date.now() + SHORT_URL_TTL_DAYS * 24 * 60 * 60 * 1000,
			).toISOString();

			const { error } = await supabase.from("short_urls").insert({
				id,
				original_url: url,
				expires_at: expiresAt,
			});

			if (!error) {
				return buildShortUrl(id);
			}

			// 23505 = unique_violation (collision on id) — retry
			if (error.code !== "23505") {
				rootLogger.warn("URL shortener insert failed", {
					url,
					attempt,
					errorCode: error.code,
					errorMessage: error.message,
				});
				break;
			}
		}
	} catch (error) {
		rootLogger.warn("URL shortener error, using original URL", { url }, error);
	}

	// Graceful degradation
	return url;
}

/**
 * Shorten multiple URLs in parallel.
 * Returns a Map from original URL → short URL (or original on failure).
 */
export async function shortenUrls(
	urls: string[],
	supabase: AppSupabaseClient,
): Promise<Map<string, string>> {
	const unique = [...new Set(urls)];
	const results = await Promise.all(
		unique.map(async (url) => [url, await shortenUrl(url, supabase)] as const),
	);
	return new Map(results);
}
