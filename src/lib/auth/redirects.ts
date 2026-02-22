const DEFAULT_SIGNIN_REDIRECT = "/dashboard";

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
	// Reject CRLF to prevent HTTP response splitting (Location header injection)
	if (value.includes("\n") || value.includes("\r")) {
		return false;
	}

	return true;
}

/**
 * Validate and normalize a redirect path from user-controlled input.
 *
 * Accepts same-origin absolute paths (e.g. `/dashboard`, `/auth/signin?redirect=`), trims whitespace,
 * and returns null for invalid input. Rejects: protocol-relative URLs (`//evil.com`), protocol
 * schemes (`javascript:`, `https://`), backslash-containing paths (bypass attempt), null, empty
 * string, and whitespace-only.
 */
export function getSafeRedirectPath(value: string | null): string | null {
	if (!value) {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	return isSafeRedirectPath(trimmed) ? trimmed : null;
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
