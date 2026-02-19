import type { APIRoute } from "astro";
import { clearAuthCookies } from "../../../lib/auth/cookies";
import { deleteUserAccount } from "../../../lib/auth/delete-account";
import { enforceAuthRateLimit } from "../../../lib/auth/enforce-auth-rate-limit";
import { createUserService } from "../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";

/*
 * Rate limit: N attempts per user per time window.
 * Can be overridden via DELETE_ACCOUNT_RATE_LIMIT_ATTEMPTS and
 * DELETE_ACCOUNT_RATE_LIMIT_MINUTES env vars.
 */
const DELETE_ACCOUNT_RATE_LIMIT_ATTEMPTS =
	Number.parseInt(
		import.meta.env.DELETE_ACCOUNT_RATE_LIMIT_ATTEMPTS ?? "5",
		10,
	) || 5;
const DELETE_ACCOUNT_RATE_LIMIT_MINUTES =
	Number.parseInt(
		import.meta.env.DELETE_ACCOUNT_RATE_LIMIT_MINUTES ?? "15",
		10,
	) || 15;

export const POST: APIRoute = async ({
	cookies,
	redirect,
	request,
	locals,
}) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);
	const authUser = await users.getCurrentUser();

	if (!authUser) {
		logger.info("Delete account requested without authenticated user", {
			reason: "unauthenticated",
		});
		clearAuthCookies(cookies);
		return redirect("/");
	}

	try {
		const adminSupabase = createSupabaseAdminClient();
		const rateLimitRedirect = await enforceAuthRateLimit({
			adminSupabase,
			userId: authUser.id,
			endpoint: "delete_account",
			maxRequests: DELETE_ACCOUNT_RATE_LIMIT_ATTEMPTS,
			windowMinutes: DELETE_ACCOUNT_RATE_LIMIT_MINUTES,
			logger,
			contextLabel: "account deletion",
		});
		if (rateLimitRedirect) return rateLimitRedirect;

		const result = await deleteUserAccount({
			adminSupabase,
			userId: authUser.id,
			logger,
		});

		if (result.ok) {
			clearAuthCookies(cookies);
			return redirect("/?success=account_deleted");
		}

		// On delete_partial we still clear cookies so the user is signed out
		if (result.redirectError === "delete_partial") {
			clearAuthCookies(cookies);
		}

		return redirect(`/profile?error=${result.redirectError}`);
	} catch (err) {
		logger.error("Failed to delete user account", { userId: authUser.id }, err);
		return redirect("/profile?error=delete_failed");
	}
};
