import type { Database } from "../db/generated/database.types";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";

/**
 * Record a notification attempt in `notification_log`.
 *
 * Returns `true` on success, `false` on failure (after logging).
 */
export async function recordNotification(
	supabase: AppSupabaseClient,
	insert: Database["public"]["Tables"]["notification_log"]["Insert"],
): Promise<boolean> {
	const { error } = await supabase.from("notification_log").insert(insert);

	if (error) {
		rootLogger.error(
			"Failed to record notification",
			{ user_id: insert.user_id ?? null },
			error,
		);
		return false;
	}

	return true;
}
