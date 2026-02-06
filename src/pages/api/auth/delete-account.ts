import type { APIRoute } from "astro";
import { clearAuthCookies } from "../../../lib/auth/cookies";
import { deleteUserAccount } from "../../../lib/auth/delete-account";
import { createUserService } from "../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";

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
