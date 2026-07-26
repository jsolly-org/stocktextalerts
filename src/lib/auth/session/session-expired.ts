import { buildClientReturnPath, getSafeRedirectPath } from "../redirects";

/**
 * Redirect the browser to the sign-in page, preserving the current path as a return URL.
 *
 * Used by client-side fetch wrappers when an API request returns 401/403.
 * Includes the hash fragment so dashboard deep links survive the auth challenge.
 */
export function redirectToSignIn(): void {
	const returnTo = buildClientReturnPath(window.location);
	const url = new URL("/auth/signin", window.location.origin);
	url.searchParams.set("error", "unauthorized");
	const safeReturnTo = getSafeRedirectPath(returnTo);
	if (safeReturnTo && safeReturnTo !== "/") {
		url.searchParams.set("redirect", safeReturnTo);
	}
	window.location.href = url.toString();
}

/**
 * Returns true when a `fetch()` response indicates the user is not authorized.
 *
 * We treat both 401 (unauthenticated) and 403 (unauthorized) as "session expired" for UI flows.
 */
export function isUnauthorizedResponse(response: Response): boolean {
	return response.status === 401 || response.status === 403;
}
