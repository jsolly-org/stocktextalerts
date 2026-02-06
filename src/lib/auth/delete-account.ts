import type { AppSupabaseClient } from "../db/supabase";
import type { Logger } from "../logging";

export type DeleteUserAccountResult =
	| { ok: true }
	| {
			ok: false;
			redirectError:
				| "delete_failed"
				| "delete_orphaned_auth_failed"
				| "delete_partial";
	  };

function isAuthUserNotFoundError(authError: unknown): boolean {
	if (!authError || typeof authError !== "object") {
		return false;
	}
	const { status, code } = authError as { status?: number; code?: string };
	return status === 404 || code === "user_not_found";
}

export async function deleteUserAccount(options: {
	adminSupabase: AppSupabaseClient;
	userId: string;
	logger: Logger;
}): Promise<DeleteUserAccountResult> {
	const { adminSupabase, userId, logger } = options;

	const { data: existingUser, error: fetchError } = await adminSupabase
		.from("users")
		.select("id")
		.eq("id", userId)
		.maybeSingle();

	if (fetchError) {
		logger.error("Failed to load user before deletion", { userId }, fetchError);
		return { ok: false, redirectError: "delete_failed" };
	}

	if (!existingUser) {
		const { error: authError } =
			await adminSupabase.auth.admin.deleteUser(userId);

		if (authError) {
			if (isAuthUserNotFoundError(authError)) {
				logger.info(
					"Auth user already missing during orphaned-account deletion; treating as success",
					{ userId },
					authError,
				);
				return { ok: true };
			}
			logger.error(
				"Failed to delete auth user when DB user already missing",
				{ userId },
				authError,
			);
			return { ok: false, redirectError: "delete_orphaned_auth_failed" };
		}

		return { ok: true };
	}

	const { error: authError } =
		await adminSupabase.auth.admin.deleteUser(userId);

	if (authError) {
		if (isAuthUserNotFoundError(authError)) {
			logger.info(
				"Auth user already missing before DB deletion; continuing as idempotent success",
				{ userId },
				authError,
			);
		} else {
			logger.error(
				"Failed to delete auth user before DB deletion",
				{ userId },
				authError,
			);
			return { ok: false, redirectError: "delete_failed" };
		}
	}

	const { error: dbError, count } = await adminSupabase
		.from("users")
		.delete({ count: "exact" })
		.eq("id", userId);

	// Supabase `.delete()` can succeed even when zero rows match (no-op).
	// If we hit that case after deleting the auth user, we must treat it as partial deletion.
	if (dbError || count === 0 || count === null) {
		logger.error(
			"CRITICAL: Failed to delete user row after auth deletion; orphaned record requires manual cleanup",
			{ userId, count, deleted: count ?? 0 },
			dbError,
		);
		return { ok: false, redirectError: "delete_partial" };
	}

	return { ok: true };
}
