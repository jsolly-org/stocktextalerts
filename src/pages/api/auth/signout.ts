import type { APIRoute } from "astro";
import { clearAuthCookies } from "../../../lib/auth/cookies";

export const POST: APIRoute = async ({ cookies, redirect }) => {
	clearAuthCookies(cookies);
	return redirect("/");
};

export const GET: APIRoute = async ({ redirect }) => {
	// Keep signout state-changing behavior on POST only; direct GETs should not error.
	return redirect("/");
};
