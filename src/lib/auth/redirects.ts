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

	return true;
}

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

export function buildSigninRedirectUrl(path: string | null): string {
	const safePath = getSafeRedirectPath(path);
	if (!safePath) {
		return "/auth/signin";
	}

	const url = new URL("/auth/signin", "http://internal");
	url.searchParams.set("redirect", safePath);
	return `${url.pathname}${url.search}`;
}

export function getPostSigninRedirect(path: string | null): string {
	return getSafeRedirectPath(path) ?? DEFAULT_SIGNIN_REDIRECT;
}
