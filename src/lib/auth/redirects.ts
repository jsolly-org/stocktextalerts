const DEFAULT_SIGNIN_REDIRECT = "/dashboard";

/** True when `value` contains C0 controls or DEL (TAB before `//` enables WHATWG open redirects). */
function hasUnsafeRedirectControlChars(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function isSafeRedirectPath(value: string): boolean {
	if (!value.startsWith("/")) {
		return false;
	}
	if (value.startsWith("//")) {
		return false;
	}
	if (value.includes("://")) {
		return false;
	}
	// Reject backslashes: /\/evil.com can become //evil.com after escape, enabling protocol-relative bypass
	if (value.includes("\\")) {
		return false;
	}
	// Reject C0/DEL (includes CR/LF) — prevents Location splitting and TAB-smuggled `//host` open redirects
	if (hasUnsafeRedirectControlChars(value)) {
		return false;
	}

	return true;
}

/**
 * Validate and normalize a redirect path from user-controlled input.
 *
 * Accepts same-origin absolute paths (e.g. `/dashboard`, `/auth/signin?redirect=`),
 * including query strings and hash fragments (`/dashboard#market-notifications`).
 * Trims whitespace and returns null for invalid input. Rejects: protocol-relative
 * URLs (`//evil.com`), protocol schemes (`javascript:`, `https://`), backslash-containing
 * paths (bypass attempt), null, empty string, and whitespace-only.
 */
export function getSafeRedirectPath(value: string | null): string | null {
	if (!value) {
		return null;
	}
	// Reject controls before trim; trim() would strip trailing CR/LF/TAB and bypass the safety check
	if (hasUnsafeRedirectControlChars(value)) {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	return isSafeRedirectPath(trimmed) ? trimmed : null;
}

/**
 * Append a hash fragment to a path when the path does not already include one.
 *
 * `hash` may be with or without a leading `#`. Empty / `#`-only values are ignored.
 */
export function appendHashIfMissing(path: string, hash: string): string {
	const trimmedHash = hash.trim();
	if (!trimmedHash || trimmedHash === "#") {
		return path;
	}
	if (path.includes("#")) {
		return path;
	}
	const normalized = trimmedHash.startsWith("#") ? trimmedHash : `#${trimmedHash}`;
	return `${path}${normalized}`;
}

/**
 * Build the browser return path (pathname + search + hash) for post-auth redirects.
 */
export function buildClientReturnPath(
	location: Pick<Location, "pathname" | "search" | "hash">,
): string {
	return `${location.pathname}${location.search}${location.hash}`;
}

/**
 * Merge a browser location hash into a sign-in form `redirect` field value.
 *
 * Servers never see URL fragments, but browsers preserve them across 302s onto
 * `/auth/signin?redirect=…`. When a hash is present on the sign-in page, fold it
 * into the redirect target so post-sign-in lands on the original deep link.
 *
 * Empty redirect + hash falls back to the default post-sign-in path + hash.
 */
export function mergeLocationHashIntoRedirectValue(redirectValue: string, hash: string): string {
	const trimmedRedirect = redirectValue.trim();
	const trimmedHash = hash.trim();
	const hasHash = Boolean(trimmedHash && trimmedHash !== "#");

	if (!hasHash) {
		return trimmedRedirect;
	}

	const merged = appendHashIfMissing(trimmedRedirect || DEFAULT_SIGNIN_REDIRECT, trimmedHash);
	return getSafeRedirectPath(merged) ?? getSafeRedirectPath(trimmedRedirect) ?? "";
}

/**
 * Build a sign-in URL that preserves a safe `redirect` query parameter.
 */
export function buildSigninRedirectUrl(path: string | null): string {
	const safePath = getSafeRedirectPath(path);
	if (!safePath) {
		return "/auth/signin";
	}

	const url = new URL("/auth/signin", "http://internal");
	url.searchParams.set("redirect", safePath);
	return `${url.pathname}${url.search}`;
}

/**
 * Choose a post-sign-in redirect target, falling back to the dashboard.
 */
export function getPostSigninRedirect(path: string | null): string {
	return getSafeRedirectPath(path) ?? DEFAULT_SIGNIN_REDIRECT;
}
