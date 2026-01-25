import type { APIRoute } from "astro";
import { clearAuthCookies } from "../../../lib/auth/cookies";
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
		logger.error("Delete account requested without authenticated user", {
			reason: "unauthenticated",
		});
		clearAuthCookies(cookies);
		return redirect("/");
	}

	try {
		const supabaseAdmin = createSupabaseAdminClient();

		// Check if the application user already no longer exists so the handler is idempotent
		const { data: existingUser, error: fetchError } = await supabaseAdmin
			.from("users")
			.select("id")
			.eq("id", authUser.id)
			.maybeSingle();

		if (fetchError) {
			logger.error(
				"Failed to load user before deletion",
				{ userId: authUser.id },
				fetchError,
			);
			return redirect("/profile?error=delete_failed");
		}

		// If the DB user is already gone, just delete auth and treat as a repeated request
		if (!existingUser) {
			const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(
				authUser.id,
			);

			if (authError) {
				logger.error(
					"Failed to delete auth user when DB user already missing",
					{ userId: authUser.id },
					authError,
				);
				return redirect("/profile?error=delete_orphaned_auth_failed");
			}

			clearAuthCookies(cookies);

			return redirect("/?success=account_deleted");
		}

		// Delete auth user first to avoid leaving an authenticated user without app data
		const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(
			authUser.id,
		);

		if (authError) {
			logger.error(
				"Failed to delete auth user before DB deletion",
				{ userId: authUser.id },
				authError,
			);
			return redirect("/profile?error=delete_failed");
		}

		const { error: dbError } = await supabaseAdmin
			.from("users")
			.delete()
			.eq("id", authUser.id);

		if (dbError) {
			logger.error(
				"CRITICAL: Failed to delete user row after auth deletion; orphaned record requires manual cleanup",
				{ userId: authUser.id },
				dbError,
			);
			clearAuthCookies(cookies);
			return redirect("/profile?error=delete_partial");
		}

		clearAuthCookies(cookies);

		return redirect("/?success=account_deleted");
	} catch (err) {
		logger.error("Failed to delete user account", { userId: authUser.id }, err);
		return redirect("/profile?error=delete_failed");
	}
};
