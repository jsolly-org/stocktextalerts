import { SHORT_URL_TTL_DAYS } from "../../constants";
import { getSiteUrl } from "../../db/env";
import type { AppSupabaseClient } from "../../db/supabase";
import { rootLogger } from "../../logging";
import { isSafeRedirectUrl } from "../../validation";

const SHORT_ID_LENGTH = 6;
const BASE62_CHARS =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_INSERT_ATTEMPTS = 3;
/** Max length for stored URLs to prevent abuse (RFC 7230 suggests 8000+ but we cap for storage). */
const MAX_ORIGINAL_URL_LENGTH = 2048;

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
 * Rejects unsafe redirect URLs (javascript:, data:, etc.) and oversized URLs.
 * Falls back to the original URL on validation failure or DB error.
 */
export async function shortenUrl(
	url: string,
	supabase: AppSupabaseClient,
): Promise<string> {
	const trimmed = typeof url === "string" ? url.trim() : "";
	if (
		trimmed.length === 0 ||
		trimmed.length > MAX_ORIGINAL_URL_LENGTH ||
		!isSafeRedirectUrl(trimmed)
	) {
		rootLogger.info("URL shortener rejected unsafe or invalid URL", {
			urlLength: trimmed.length,
			rejected: trimmed.length > 100 ? `${trimmed.slice(0, 100)}...` : trimmed,
		});
		// Return trimmed for consistency with DB error path.
		return trimmed;
	}

	try {
		// Check for existing short URL (dedup)
		const { data: existing } = await supabase
			.from("short_urls")
			.select("id")
			.eq("original_url", trimmed)
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
				original_url: trimmed,
				expires_at: expiresAt,
			});

			if (!error) {
				return buildShortUrl(id);
			}

			// 23505 = unique_violation (collision on id) — retry
			if (error.code !== "23505") {
				rootLogger.error("URL shortener insert failed", {
					url: trimmed,
					attempt,
					errorCode: error.code,
					errorMessage: error.message,
				});
				break;
			}
		}
	} catch (error) {
		rootLogger.error(
			"URL shortener error, using original URL",
			{
				url: trimmed,
			},
			error,
		);
	}

	// Graceful degradation
	return trimmed;
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
