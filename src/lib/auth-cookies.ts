import type { AstroCookies } from "astro";

const authCookieOptions = {
	path: "/",
	httpOnly: true,
	secure: import.meta.env.PROD,
	sameSite: "lax" as const,
};

export function setAuthCookies(
	cookies: AstroCookies,
	accessToken: string,
	refreshToken: string,
): void {
	cookies.set("sb-access-token", accessToken, authCookieOptions);
	cookies.set("sb-refresh-token", refreshToken, authCookieOptions);
}

export function clearAuthCookies(cookies: AstroCookies): void {
	cookies.delete("sb-access-token", authCookieOptions);
	cookies.delete("sb-refresh-token", authCookieOptions);
}
