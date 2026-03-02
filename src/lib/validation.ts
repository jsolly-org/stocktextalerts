/**
 * UUID format validation (RFC 4122 structure).
 * Use before DB lookups to reject malformed input and avoid injection edge cases.
 */
const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string | null | undefined): value is string {
	return typeof value === "string" && UUID_REGEX.test(value);
}

/** Forbidden protocol prefixes for redirect URLs (XSS / open redirect). */
const UNSAFE_REDIRECT_PREFIXES = [
	"javascript:",
	"data:",
	"vbscript:",
	"file:",
] as const;

/** CR/LF in redirect URL would allow HTTP response splitting. */
const CRLF_RE = /\r|\n/;

/**
 * Returns true if the value is safe to use as an HTTP Location header.
 * Allows only http: and https: URLs; rejects CR/LF and script/data protocols.
 */
export function isSafeRedirectUrl(value: string | null | undefined): boolean {
	if (typeof value !== "string" || value.trim() === "") {
		return false;
	}
	const trimmed = value.trim();
	if (CRLF_RE.test(trimmed)) {
		return false;
	}
	const lower = trimmed.toLowerCase();
	for (const prefix of UNSAFE_REDIRECT_PREFIXES) {
		if (lower.startsWith(prefix)) {
			return false;
		}
	}
	return lower.startsWith("http://") || lower.startsWith("https://");
}
