import type { AstroCookies } from "astro";

const authCookieOptions = {
	path: "/",
	httpOnly: true,
	secure: import.meta.env.PROD,
	sameSite: "lax" as const,
};

/**
 * Persist Supabase auth tokens into HTTP-only cookies.
 */
export function setAuthCookies(
	cookies: AstroCookies,
	accessToken: string,
	refreshToken: string,
): void {
	cookies.set("sb-access-token", accessToken, authCookieOptions);
	cookies.set("sb-refresh-token", refreshToken, authCookieOptions);
}

/**
 * Clear any persisted Supabase auth cookies.
 */
export function clearAuthCookies(cookies: AstroCookies): void {
	cookies.delete("sb-access-token", authCookieOptions);
	cookies.delete("sb-refresh-token", authCookieOptions);
}
