import type { APIRoute } from "astro";
import { clearAuthCookies } from "../../../lib/auth-cookies";

export const POST: APIRoute = async ({ cookies, redirect }) => {
	clearAuthCookies(cookies);
	return redirect("/");
};
