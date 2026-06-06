import type { BrowserContextOptions } from "@playwright/test";
import { createAuthenticatedCookies } from "../test-env";

/** Build a Playwright storageState object from Supabase session cookies. */
export async function buildAuthStorageState(
	baseOrigin: string,
	email: string,
	password: string,
): Promise<NonNullable<BrowserContextOptions["storageState"]>> {
	const authCookies = await createAuthenticatedCookies(email, password);
	const origin = new URL(baseOrigin);
	const cookieDefaults = {
		domain: origin.hostname,
		path: "/",
		expires: -1,
		httpOnly: true,
		secure: origin.protocol === "https:",
		sameSite: "Lax" as const,
	};
	return {
		cookies: [
			{
				name: "sb-access-token",
				value: authCookies.get("sb-access-token") ?? "",
				...cookieDefaults,
			},
			{
				name: "sb-refresh-token",
				value: authCookies.get("sb-refresh-token") ?? "",
				...cookieDefaults,
			},
		],
		origins: [],
	};
}
