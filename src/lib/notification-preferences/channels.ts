import type { FacetCatalogEntry, NotificationOptionFieldName } from "../constants";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../constants";
import type { AppSupabaseClient } from "../db/supabase";
import type { Logger } from "../logging";
import { isFacetEnabled, parsePrefRow } from "../messaging/notification-prefs";
import type { PrefRow } from "../types";

/* =============
Channel notification-preference persistence (email, sms, telegram).

ALL per-option channel preferences live in `notification_preferences`, one row
per (user_id, notification_type, content, channel). This is the single source of
truth — there are no per-column `*_include_*` flags on `users` anymore.

Every catalog option maps to exactly one form field (`entry.fieldName`, derived
from NOTIFICATION_OPTION_MATRIX); only fields actually present in the submission
are written (no-drift: an unsubmitted option leaves its existing row untouched).
============= */

/** field name → its catalog option, for every valid option. */
const CHANNEL_PREFERENCE_FIELD_MAP: ReadonlyMap<string, FacetCatalogEntry> = new Map(
	NOTIFICATION_PREFERENCE_CATALOG.map((entry) => [entry.fieldName, entry]),
);

/**
 * Upsert `notification_preferences` rows for every channel preference present in
 * this submission (email, sms, telegram alike — uniform peers).
 *
 * Only fields actually submitted are written (no-drift). `supabase` must be the
 * request's session-scoped client; RLS allows a user to write only their own rows.
 *
 * Throws if the upsert fails so the caller can surface a 500.
 */
export async function persistChannelPreferences(options: {
	supabase: AppSupabaseClient;
	userId: string;
	parsedData: Partial<Record<string, boolean>>;
	formData: FormData;
	logger?: Logger;
}): Promise<void> {
	const { supabase, userId, parsedData, formData, logger } = options;

	const rows = [...CHANNEL_PREFERENCE_FIELD_MAP.values()].flatMap((target) => {
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
				channel: target.channel,
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
		.upsert(rows, { onConflict: "user_id,notification_type,content,channel" });

	if (error) {
		logger?.error(
			"Failed to upsert notification preferences",
			{ userId, fieldCount: rows.length },
			error,
		);
		throw error;
	}
}

/* =============
Per-option snapshot: the flat `<field>: boolean` map the dashboard UI consumes,
reconstructed from notification_preferences rows. This is the boundary translation
between the table (source of truth) and the existing per-option UI shape.
============= */

/** The flat per-option snapshot keyed by dashboard field name (all channels). */
type ChannelPreferenceSnapshot = Record<NotificationOptionFieldName, boolean>;

/** Build the flat per-option snapshot from a user's preference rows. Every
 *  catalog option gets a key; options with no row default to `false`. */
export function buildChannelPreferenceSnapshot(
	prefs: readonly PrefRow[],
): ChannelPreferenceSnapshot {
	const snapshot = {} as ChannelPreferenceSnapshot;
	for (const entry of NOTIFICATION_PREFERENCE_CATALOG) {
		snapshot[entry.fieldName] = isFacetEnabled(
			prefs,
			entry.notification_type,
			entry.channel,
			entry.content,
		);
	}
	return snapshot;
}

/** Load a single user's preference rows from notification_preferences.
 *
 * Throws on a failed read (unlike the Lambda fan-out's `loadPrefsByUser`, which
 * deliberately fails open with empty rows): every web caller renders or writes
 * from these rows, and an empty result on error would show all 31 options as
 * OFF — one autosave later, `persistChannelPreferences` would durably persist
 * that wipe. Failing loud turns a DB blip into a 500 instead. */
export async function loadUserPreferenceRows(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<PrefRow[]> {
	const { data, error } = await supabase
		.from("notification_preferences")
		.select("notification_type, content, channel, enabled")
		.eq("user_id", userId);

	if (error) {
		throw error;
	}

	return (data ?? []).map(parsePrefRow).filter((row): row is PrefRow => row !== null);
}
