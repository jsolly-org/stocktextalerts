import type {
	DeliveryChannelMode,
	FacetCatalogEntry,
	NotificationOptionFieldName,
} from "../constants";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../constants";
import type { AppSupabaseClient } from "../db/supabase";
import type { Logger } from "../logging";
import { isFacetEnabled, parsePrefRow } from "../messaging/notification-prefs";
import type { PrefRow } from "../types";

/* =============
Notification-preference persistence (content toggles).

Post-contract: one row per (user_id, notification_type, content).
Expand-era (pre-flatten migrate): channel-keyed rows still exist. Writers try
channel-keyed upsert first (channel = active pipe, or email when disabled),
then fall back to flat upsert after the contract migration drops `channel`.
============= */

/** field name → its catalog option, for every valid option. */
const PREFERENCE_FIELD_MAP: ReadonlyMap<string, FacetCatalogEntry> = new Map(
	NOTIFICATION_PREFERENCE_CATALOG.map((entry) => [entry.fieldName, entry]),
);

function isPrefsSchemaMismatch(error: { message?: string; code?: string }): boolean {
	const msg = error.message ?? "";
	return (
		error.code === "PGRST204" ||
		/could not find.*column/i.test(msg) ||
		/column .* does not exist/i.test(msg) ||
		/ON CONFLICT/i.test(msg) ||
		/no unique or exclusion constraint/i.test(msg)
	);
}

/** Content grain used when dual-writing expand-era channel-keyed prefs. */
export function preferenceWriteChannel(deliveryChannel: DeliveryChannelMode): "email" | "telegram" {
	return deliveryChannel === "telegram" ? "telegram" : "email";
}

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
	deliveryChannel: DeliveryChannelMode;
	logger?: Logger;
}): Promise<void> {
	const { supabase, userId, parsedData, formData, deliveryChannel, logger } = options;

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

	const writeChannel = preferenceWriteChannel(deliveryChannel);
	const rowsWithChannel = rows.map((row) => ({ ...row, channel: writeChannel }));

	const { error: channelError } = await supabase
		.from("notification_preferences")
		// Expand-era PK includes channel; cast until contract migrate drops it.
		.upsert(rowsWithChannel as never, {
			onConflict: "user_id,notification_type,content,channel",
		});

	if (!channelError) {
		return;
	}
	if (!isPrefsSchemaMismatch(channelError)) {
		logger?.error(
			"Failed to upsert notification preferences",
			{ userId, fieldCount: rows.length, mode: "channel" },
			channelError,
		);
		throw channelError;
	}

	const { error: flatError } = await supabase
		.from("notification_preferences")
		.upsert(rows, { onConflict: "user_id,notification_type,content" });

	if (flatError) {
		logger?.error(
			"Failed to upsert notification preferences",
			{ userId, fieldCount: rows.length, mode: "flat" },
			flatError,
		);
		throw flatError;
	}
}

/** Seed signup defaults with the same expand→contract dual-path as autosave. */
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
	const withChannel = rows.map((row) => ({ ...row, channel: "email" as const }));

	const { error: channelError } = await supabase
		.from("notification_preferences")
		.upsert(withChannel as never, {
			onConflict: "user_id,notification_type,content,channel",
		});
	if (!channelError) {
		return;
	}
	if (!isPrefsSchemaMismatch(channelError)) {
		logger?.error(
			"Failed to seed default notification preferences",
			{ userId, mode: "channel" },
			channelError,
		);
		throw channelError;
	}

	const { error: flatError } = await supabase
		.from("notification_preferences")
		.upsert(rows, { onConflict: "user_id,notification_type,content" });
	if (flatError) {
		logger?.error(
			"Failed to seed default notification preferences",
			{ userId, mode: "flat" },
			flatError,
		);
		throw flatError;
	}
}

/* =============
Per-option snapshot: the flat `<field>: boolean` map the dashboard UI consumes,
reconstructed from notification_preferences rows.
============= */

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

type PrefRowWithOptionalChannel = {
	notification_type: string;
	content: string;
	enabled: boolean;
	channel?: string | null;
};

/**
 * Collapse expand-era channel grains into one PrefRow per (type, content).
 * Prefer the account's active pipe, then email, then telegram, then any enabled.
 */
export function collapsePreferenceRows(
	rows: readonly PrefRowWithOptionalChannel[],
	deliveryChannel: DeliveryChannelMode,
): PrefRow[] {
	const preferred =
		deliveryChannel === "telegram" || deliveryChannel === "email" ? deliveryChannel : "email";

	type Acc = {
		email?: PrefRowWithOptionalChannel;
		telegram?: PrefRowWithOptionalChannel;
		other: PrefRowWithOptionalChannel[];
	};
	const byKey = new Map<string, Acc>();

	for (const row of rows) {
		const key = `${row.notification_type}|${row.content}`;
		const acc = byKey.get(key) ?? { other: [] };
		if (row.channel === "email") acc.email = row;
		else if (row.channel === "telegram") acc.telegram = row;
		else acc.other.push(row);
		byKey.set(key, acc);
	}

	const collapsed: PrefRow[] = [];
	for (const acc of byKey.values()) {
		const pick =
			(preferred === "telegram" ? acc.telegram : acc.email) ??
			acc.email ??
			acc.telegram ??
			acc.other.find((r) => r.enabled) ??
			acc.other[0];
		if (!pick) continue;
		const parsed = parsePrefRow(pick);
		if (parsed) collapsed.push(parsed);
	}
	return collapsed;
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
	deliveryChannel: DeliveryChannelMode = "email",
): Promise<PrefRow[]> {
	const withChannel = await supabase
		.from("notification_preferences")
		.select("notification_type, content, enabled, channel")
		.eq("user_id", userId);

	if (!withChannel.error) {
		return collapsePreferenceRows(
			(withChannel.data ?? []) as unknown as PrefRowWithOptionalChannel[],
			deliveryChannel,
		);
	}

	if (!isPrefsSchemaMismatch(withChannel.error)) {
		throw withChannel.error;
	}

	const { data, error } = await supabase
		.from("notification_preferences")
		.select("notification_type, content, enabled")
		.eq("user_id", userId);

	if (error) {
		throw error;
	}

	return (data ?? []).map(parsePrefRow).filter((row): row is PrefRow => row !== null);
}
