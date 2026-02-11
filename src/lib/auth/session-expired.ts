/**
 * Redirect the browser to the sign-in page, preserving the current path as a return URL.
 *
 * Used by client-side fetch wrappers when an API request returns 401/403.
 */
export function redirectToSignIn(): void {
	const returnTo = `${window.location.pathname}${window.location.search}`;
	const url = new URL("/auth/signin", window.location.origin);
	url.searchParams.set("error", "unauthorized");
	if (returnTo && returnTo !== "/") {
		url.searchParams.set("redirect", returnTo);
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
