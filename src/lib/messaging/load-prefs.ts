import type { DeliveryChannelMode } from "../constants";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import { collapsePreferenceRows } from "../notification-preferences/preferences";
import type { PrefRow } from "../types";
import { parsePrefRow } from "./notification-prefs";

/* =============
Batch loader for notification_preferences rows.

`notification_preferences` is the single source of truth for content toggles.
PostgREST can't filter the `users` table against it in one query — so the user
query layer fetches a candidate set (gated by delivery_channel) and then
attaches each user's preference rows here in a single batched IN query.

Expand-era rows may still include `channel`; collapse to one PrefRow per
(type, content) using the account's delivery_channel.
============= */

function isPrefsSchemaMismatch(error: { message?: string; code?: string }): boolean {
	const msg = error.message ?? "";
	return (
		error.code === "PGRST204" ||
		/could not find.*column/i.test(msg) ||
		/column .* does not exist/i.test(msg)
	);
}

/** Load all preference rows for the given user ids, grouped by user_id. */
async function loadPrefsByUser(
	supabase: AppSupabaseClient,
	users: readonly { id: string; delivery_channel?: DeliveryChannelMode }[],
): Promise<Map<string, PrefRow[]>> {
	const byUser = new Map<string, PrefRow[]>();
	const userIds = users.map((u) => u.id);
	if (userIds.length === 0) {
		return byUser;
	}

	const channelByUser = new Map(users.map((u) => [u.id, u.delivery_channel ?? ("email" as const)]));

	const withChannel = await supabase
		.from("notification_preferences")
		.select("user_id, notification_type, content, enabled, channel")
		.in("user_id", [...new Set(userIds)]);

	if (!withChannel.error) {
		const rawByUser = new Map<
			string,
			Array<{
				notification_type: string;
				content: string;
				enabled: boolean;
				channel?: string | null;
			}>
		>();
		for (const row of withChannel.data ?? []) {
			const r = row as unknown as {
				user_id: string;
				notification_type: string;
				content: string;
				enabled: boolean;
				channel?: string | null;
			};
			const list = rawByUser.get(r.user_id) ?? [];
			list.push(r);
			rawByUser.set(r.user_id, list);
		}
		for (const [userId, rows] of rawByUser) {
			byUser.set(userId, collapsePreferenceRows(rows, channelByUser.get(userId) ?? "email"));
		}
		return byUser;
	}

	if (!isPrefsSchemaMismatch(withChannel.error)) {
		rootLogger.error(
			"Failed to load notification preferences",
			{ action: "load_prefs" },
			withChannel.error,
		);
		return byUser;
	}

	const { data, error } = await supabase
		.from("notification_preferences")
		.select("user_id, notification_type, content, enabled")
		.in("user_id", [...new Set(userIds)]);

	if (error) {
		rootLogger.error("Failed to load notification preferences", { action: "load_prefs" }, error);
		return byUser;
	}

	for (const row of data ?? []) {
		const r = row as {
			user_id: string;
			notification_type: string;
			content: string;
			enabled: boolean;
		};
		const pref = parsePrefRow(r);
		if (!pref) {
			rootLogger.warn("Skipping invalid notification preference row", {
				action: "load_prefs",
				userId: r.user_id,
				notification_type: r.notification_type,
				content: r.content,
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
export async function attachPrefsToUsers<
	T extends { id: string; delivery_channel?: DeliveryChannelMode },
>(supabase: AppSupabaseClient, users: readonly T[]): Promise<Array<T & { prefs: PrefRow[] }>> {
	const byUser = await loadPrefsByUser(supabase, users);
	return users.map((u) => ({ ...u, prefs: byUser.get(u.id) ?? [] }));
}
