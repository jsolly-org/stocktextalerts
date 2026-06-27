import type { AstroCookies } from "astro";

const authCookieOptions = {
	path: "/",
	httpOnly: true,
	secure: (process.env.NODE_ENV ?? process.env.MODE) === "production",
	sameSite: "lax" as const,
};

/** Persist Supabase auth tokens into httpOnly cookies for SSR requests. */
export function setAuthCookies(
	cookies: AstroCookies,
	accessToken: string,
	refreshToken: string,
): void {
	cookies.set("sb-access-token", accessToken, authCookieOptions);
	cookies.set("sb-refresh-token", refreshToken, authCookieOptions);
}

/** Remove Supabase auth token cookies (sign-out / session reset). */
export function clearAuthCookies(cookies: AstroCookies): void {
	cookies.delete("sb-access-token", authCookieOptions);
	cookies.delete("sb-refresh-token", authCookieOptions);
}
