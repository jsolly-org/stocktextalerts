import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import type { PrefRow } from "../types";
import { parsePrefRow } from "./notification-prefs";

/* =============
Batch loader for notification_preferences rows.

`notification_preferences` is the single source of truth for all channels, but
PostgREST can't filter the `users` table against it in one query — so the user
query layer fetches a candidate set (gated by channel-level columns) and then
attaches each user's preference rows here in a single batched IN query.
============= */

/** Load all preference rows for the given user ids, grouped by user_id. */
export async function loadPrefsByUser(
	supabase: AppSupabaseClient,
	userIds: readonly string[],
): Promise<Map<string, PrefRow[]>> {
	const byUser = new Map<string, PrefRow[]>();
	if (userIds.length === 0) {
		return byUser;
	}

	const { data, error } = await supabase
		.from("notification_preferences")
		.select("user_id, notification_type, content, channel, enabled")
		.in("user_id", [...new Set(userIds)]);

	if (error) {
		rootLogger.error("Failed to load notification preferences", { action: "load_prefs" }, error);
		// Fail open with empty rows: each user simply has no enabled facets, so no
		// channel is "wanted" — never crashes the fan-out, never sends spuriously.
		return byUser;
	}

	for (const row of data ?? []) {
		const r = row as {
			user_id: string;
			notification_type: string;
			content: string;
			channel: string;
			enabled: boolean;
		};
		const pref = parsePrefRow(r);
		if (!pref) {
			rootLogger.warn("Skipping invalid notification preference row", {
				action: "load_prefs",
				userId: r.user_id,
				notification_type: r.notification_type,
				content: r.content,
				channel: r.channel,
			});
			continue;
		}
		const list = byUser.get(r.user_id) ?? [];
		list.push(pref);
		byUser.set(r.user_id, list);
	}

	return byUser;
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
