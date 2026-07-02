import { PREF_CHANNELS } from "../constants";
import type { AppSupabaseClient } from "../db/supabase";
import type { Logger } from "../logging";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../messaging/constants";
import { loadPrefsByUser } from "../messaging/load-prefs";
import { isFacetEnabled } from "../messaging/notification-prefs";
import type { PrefChannel, PrefRow } from "../types";

/* =============
Channel notification-preference persistence (email, sms, telegram).

ALL per-option channel preferences live in `notification_preferences`, one row
per (user_id, notification_type, content, channel). This is the single source of
truth — there are no per-column `*_include_*` flags on `users` anymore.

Each dashboard form field is named `<notification_type>_include_<facet>_<channel>`
for faceted types (daily_digest, asset_events) or `<notification_type>_include_<channel>`
for the facet-less market/price types (content = ""). Every catalog entry maps to
exactly one field; only fields actually present in the submission are written
(no-drift: an unsubmitted option leaves its existing row untouched).
============= */

/** A submitted preference form field mapped to its (type, content, channel) row key. */
interface ChannelPreferenceTarget {
	notification_type: string;
	content: string;
	channel: PrefChannel;
}

/** The dashboard form-field name for a catalog entry. */
function fieldNameFor(notification_type: string, content: string, channel: PrefChannel): string {
	return content === ""
		? `${notification_type}_include_${channel}`
		: `${notification_type}_include_${content}_${channel}`;
}

/** field name → (notification_type, content, channel) for every catalog option. */
const CATALOG_FIELD_MAP: Record<string, ChannelPreferenceTarget> = Object.fromEntries(
	NOTIFICATION_PREFERENCE_CATALOG.map((entry) => [
		fieldNameFor(entry.notification_type, entry.content, entry.channel),
		{
			notification_type: entry.notification_type,
			content: entry.content,
			channel: entry.channel,
		},
	]),
);

/** Legacy dashboard field names → daily_notification rows (one release-window compat). */
const LEGACY_DAILY_FIELD_ALIASES: Record<string, ChannelPreferenceTarget> = {
	...Object.fromEntries(
		(["prices", "top_movers", "news", "rumors"] as const).flatMap((content) =>
			PREF_CHANNELS.filter(
				(channel) => channel !== "sms" || content === "prices" || content === "top_movers",
			).map((channel) => [
				`daily_digest_include_${content}_${channel}`,
				{ notification_type: "daily_notification", content, channel },
			]),
		),
	),
	...Object.fromEntries(
		(["calendar", "ipo", "analyst", "insider"] as const).flatMap((content) =>
			PREF_CHANNELS.map((channel) => [
				`asset_events_include_${content}_${channel}`,
				{ notification_type: "daily_notification", content, channel },
			]),
		),
	),
};

const CHANNEL_PREFERENCE_FIELD_MAP: Record<string, ChannelPreferenceTarget> = {
	...CATALOG_FIELD_MAP,
	...LEGACY_DAILY_FIELD_ALIASES,
};

const CHANNEL_PREFERENCE_FIELD_NAMES = Object.keys(CHANNEL_PREFERENCE_FIELD_MAP);

/** Every boolean field name in the notification-preferences form schema (all channels). */
type ChannelPreferenceFieldName = keyof typeof CHANNEL_PREFERENCE_FIELD_MAP;

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

	const rows = CHANNEL_PREFERENCE_FIELD_NAMES.flatMap((field) => {
		const value = parsedData[field];
		const target = CHANNEL_PREFERENCE_FIELD_MAP[field];
		if (!formData.has(field) || value === undefined || target === undefined) {
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
type ChannelPreferenceSnapshot = Record<ChannelPreferenceFieldName, boolean>;

/** Build the flat per-option snapshot from a user's preference rows. */
export function buildChannelPreferenceSnapshot(
	prefs: readonly PrefRow[],
): ChannelPreferenceSnapshot {
	const snapshot = {} as ChannelPreferenceSnapshot;
	for (const entry of NOTIFICATION_PREFERENCE_CATALOG) {
		const field = fieldNameFor(entry.notification_type, entry.content, entry.channel);
		const enabled = isFacetEnabled(prefs, entry.notification_type, entry.channel, entry.content);
		snapshot[field] = enabled;
	}
	// Legacy dashboard field names (daily_digest_*, asset_events_*)
	for (const [legacyField, target] of Object.entries(LEGACY_DAILY_FIELD_ALIASES)) {
		snapshot[legacyField as ChannelPreferenceFieldName] = isFacetEnabled(
			prefs,
			target.notification_type as "daily_notification",
			target.channel,
			target.content as "prices",
		);
	}
	return snapshot;
}

/** Load a single user's preference rows from notification_preferences. */
export async function loadUserPreferenceRows(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<PrefRow[]> {
	const byUser = await loadPrefsByUser(supabase, [userId]);
	return byUser.get(userId) ?? [];
}
