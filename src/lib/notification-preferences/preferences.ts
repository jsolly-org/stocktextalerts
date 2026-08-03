import type { FacetCatalogEntry, NotificationOptionFieldName } from "../constants";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../constants";
import type { AppSupabaseClient } from "../db/supabase";
import type { User } from "../db/types";
import type { Logger } from "../logging";
import { isFacetEnabled, parsePrefRow } from "../messaging/notification-prefs";
import type { PrefRow } from "../types";
import type { NotificationPreferenceDbRow } from "./types";

/* =============
Notification-preference persistence (content toggles).

One row per (user_id, notification_type, content). Account routing lives on
`users.delivery_channel`, not on these rows.
============= */

/** field name → its catalog option, for every valid option. */
const PREFERENCE_FIELD_MAP: ReadonlyMap<string, FacetCatalogEntry> = new Map(
	NOTIFICATION_PREFERENCE_CATALOG.map((entry) => [entry.fieldName, entry]),
);

/**
 * Upsert `notification_preferences` rows for every content preference present in
 * this submission.
 *
 * Only fields actually submitted are written (no-drift). `supabase` must be the
 * request's session-scoped client; RLS allows a user to write only their own rows.
 *
 * Throws if the upsert fails so the caller can surface a 500.
 */
export async function persistNotificationPreferences(options: {
	supabase: AppSupabaseClient;
	userId: string;
	parsedData: Partial<Record<string, boolean>>;
	formData: FormData;
	logger?: Logger;
}): Promise<void> {
	const { supabase, userId, parsedData, formData, logger } = options;

	const rows = [...PREFERENCE_FIELD_MAP.values()].flatMap((target) => {
		const field = target.fieldName;
		const value = parsedData[field];
		if (!formData.has(field) || value === undefined) {
			return [];
		}
		return [
			{
				user_id: userId,
				notification_type: target.notification_type,
				content: target.content,
				enabled: value,
				updated_at: new Date().toISOString(),
			},
		];
	});

	if (rows.length === 0) {
		return;
	}

	const { error } = await supabase
		.from("notification_preferences")
		.upsert(rows, { onConflict: "user_id,notification_type,content" });

	if (error) {
		logger?.error(
			"Failed to upsert notification preferences",
			{ userId, fieldCount: rows.length },
			error,
		);
		throw error;
	}
}

/** Seed signup defaults into flat `notification_preferences` rows. */
export async function seedDefaultNotificationPreferences(options: {
	supabase: AppSupabaseClient;
	userId: string;
	rows: Array<{
		user_id: string;
		notification_type: string;
		content: string;
		enabled: boolean;
	}>;
	logger?: Logger;
}): Promise<void> {
	const { supabase, userId, rows, logger } = options;

	const { error } = await supabase
		.from("notification_preferences")
		.upsert(rows, { onConflict: "user_id,notification_type,content" });
	if (error) {
		logger?.error("Failed to seed default notification preferences", { userId }, error);
		throw error;
	}
}

/** The flat per-option snapshot keyed by dashboard field name. */
type PreferenceSnapshot = Record<NotificationOptionFieldName, boolean>;

/** Build the flat per-option snapshot from a user's preference rows. Every
 *  catalog option gets a key; options with no row default to `false`. */
export function buildPreferenceSnapshot(prefs: readonly PrefRow[]): PreferenceSnapshot {
	const snapshot = {} as PreferenceSnapshot;
	for (const entry of NOTIFICATION_PREFERENCE_CATALOG) {
		snapshot[entry.fieldName] = isFacetEnabled(prefs, entry.notification_type, entry.content);
	}
	return snapshot;
}

/** Full API/dashboard snapshot: account routing + schedule fields from `users`,
 *  plus per-option content toggles from preference rows. */
export function buildNotificationPreferencesApiSnapshot(
	dbUser: Pick<
		User,
		| "market_scheduled_asset_price_enabled"
		| "delivery_channel"
		| "timezone"
		| "market_scheduled_asset_price_times"
		| "daily_notification_time"
		| "daily_notification_next_send_at"
		| "market_scheduled_asset_price_next_send_at"
		| "dismiss_timezone_mismatch_prompts"
	>,
	prefs: readonly PrefRow[],
) {
	return {
		market_scheduled_asset_price_enabled: dbUser.market_scheduled_asset_price_enabled,
		delivery_channel: dbUser.delivery_channel,
		timezone: dbUser.timezone,
		market_scheduled_asset_price_times: dbUser.market_scheduled_asset_price_times,
		daily_notification_time: dbUser.daily_notification_time,
		daily_notification_next_send_at: dbUser.daily_notification_next_send_at,
		market_scheduled_asset_price_next_send_at: dbUser.market_scheduled_asset_price_next_send_at,
		dismiss_timezone_mismatch_prompts: dbUser.dismiss_timezone_mismatch_prompts,
		...buildPreferenceSnapshot(prefs),
	};
}

/** Batch-load raw preference rows for one or more users. Uses `.eq` for a single
 *  id and `.in` otherwise. Returns `{ data, error }` — callers decide throw vs fail-open. */
export async function queryNotificationPreferenceRows(
	supabase: AppSupabaseClient,
	userIds: readonly string[],
): Promise<{ data: NotificationPreferenceDbRow[] | null; error: Error | null }> {
	const uniqueIds = [...new Set(userIds)];
	if (uniqueIds.length === 0) {
		return { data: [], error: null };
	}

	const base = supabase
		.from("notification_preferences")
		.select("user_id, notification_type, content, enabled");
	const singleUserId = uniqueIds[0];
	const { data, error } =
		uniqueIds.length === 1 && singleUserId !== undefined
			? await base.eq("user_id", singleUserId)
			: await base.in("user_id", uniqueIds);

	return { data: data as NotificationPreferenceDbRow[] | null, error: error as Error | null };
}

/** Group parsed preference rows by user_id; optionally warn on invalid rows. */
export function groupPrefRowsByUser(
	rows: readonly NotificationPreferenceDbRow[],
	onInvalid?: (row: NotificationPreferenceDbRow) => void,
): Map<string, PrefRow[]> {
	const byUser = new Map<string, PrefRow[]>();
	for (const row of rows) {
		const pref = parsePrefRow(row);
		if (!pref) {
			onInvalid?.(row);
			continue;
		}
		const list = byUser.get(row.user_id) ?? [];
		list.push(pref);
		byUser.set(row.user_id, list);
	}
	return byUser;
}

/** Load a single user's preference rows from notification_preferences.
 *
 * Throws on a failed read (unlike the Lambda fan-out attach path, which
 * deliberately fails open with empty rows): every web caller renders or writes
 * from these rows, and an empty result on error would show all options as
 * OFF — one autosave later, `persistNotificationPreferences` would durably
 * persist that wipe. Failing loud turns a DB blip into a 500 instead. */
export async function loadUserPreferenceRows(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<PrefRow[]> {
	const { data, error } = await queryNotificationPreferenceRows(supabase, [userId]);

	if (error) {
		throw error;
	}

	return groupPrefRowsByUser(data ?? []).get(userId) ?? [];
}
