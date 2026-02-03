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
		logger.error(
			"Failed to delete auth user before DB deletion",
			{ userId },
			authError,
		);
		return { ok: false, redirectError: "delete_failed" };
	}

	const {
		error: dbError,
		count,
		data,
	} = await adminSupabase
		.from("users")
		.delete({ count: "exact" })
		.eq("id", userId);

	if (dbError) {
		logger.error(
			"CRITICAL: Failed to delete user row after auth deletion; orphaned record requires manual cleanup",
			{ userId },
			dbError,
		);
		return { ok: false, redirectError: "delete_partial" };
	}

	if (count !== 1) {
		logger.error(
			"CRITICAL: User deletion did not delete exactly one row after auth deletion",
			{
				userId,
				count,
				data,
			},
		);
		return { ok: false, redirectError: "delete_partial" };
	}

	return { ok: true };
}
