import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import {
	groupPrefRowsByUser,
	queryNotificationPreferenceRows,
} from "../notification-preferences/preferences";
import type { PrefRow } from "../types";

/* =============
Batch loader for notification_preferences rows.

`notification_preferences` is the single source of truth for content toggles.
PostgREST can't filter the `users` table against it in one query — so the user
query layer fetches a candidate set (gated by delivery_channel) and then
attaches each user's preference rows here in a single batched IN query.
============= */

/** Load all preference rows for the given user ids, grouped by user_id. */
async function loadPrefsByUser(
	supabase: AppSupabaseClient,
	userIds: readonly string[],
): Promise<Map<string, PrefRow[]>> {
	if (userIds.length === 0) {
		return new Map();
	}

	const { data, error } = await queryNotificationPreferenceRows(supabase, userIds);

	if (error) {
		rootLogger.error("Failed to load notification preferences", { action: "load_prefs" }, error);
		return new Map();
	}

	return groupPrefRowsByUser(data ?? [], (row) => {
		rootLogger.warn("Skipping invalid notification preference row", {
			action: "load_prefs",
			userId: row.user_id,
			notification_type: row.notification_type,
			content: row.content,
		});
	});
}

/** Attach a `prefs` array to each user record by batch-loading their preference rows. */
export async function attachPrefsToUsers<T extends { id: string }>(
	supabase: AppSupabaseClient,
	users: readonly T[],
): Promise<Array<T & { prefs: PrefRow[] }>> {
	const byUser = await loadPrefsByUser(
		supabase,
		users.map((u) => u.id),
	);
	return users.map((u) => ({ ...u, prefs: byUser.get(u.id) ?? [] }));
}
