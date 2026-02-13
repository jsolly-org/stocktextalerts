import type { APIRoute } from "astro";
import { clearAuthCookies } from "../../../lib/auth/cookies";

/**
 * Sign the user out by clearing auth cookies.
 *
 * This endpoint is intentionally state-changing and should be invoked via POST.
 */
export const POST: APIRoute = async ({ cookies, redirect }) => {
	clearAuthCookies(cookies);
	return redirect("/");
};

/**
 * Redirect GET requests to home.
 *
 * Keeping GET non-state-changing avoids accidental sign-outs via prefetches or
 * crawlers while still providing a safe navigation path.
 */
export const GET: APIRoute = async ({ redirect }) => {
	// Keep signout state-changing behavior on POST only; direct GETs should not error.
	return redirect("/");
};
