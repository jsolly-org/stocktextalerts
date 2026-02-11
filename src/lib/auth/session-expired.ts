export function redirectToSignIn(): void {
	const returnTo = `${window.location.pathname}${window.location.search}`;
	const url = new URL("/auth/signin", window.location.origin);
	url.searchParams.set("error", "unauthorized");
	if (returnTo && returnTo !== "/") {
		url.searchParams.set("redirect", returnTo);
	}
	window.location.href = url.toString();
}

export function isUnauthorizedResponse(response: Response): boolean {
	return response.status === 401 || response.status === 403;
}
