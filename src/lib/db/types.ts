import type { NotificationOptionFieldName } from "../constants";
import type { AssetType } from "../types";
import type { Database } from "./generated/database.types";

/* =============
Row Types
============= */

type DbUserRow = Database["public"]["Tables"]["users"]["Row"];
type DbUserUpdate = Database["public"]["Tables"]["users"]["Update"];

type DbAssetRow = Database["public"]["Tables"]["assets"]["Row"];
type DbUserAssetRow = Database["public"]["Tables"]["user_assets"]["Row"];

/* =============
Public Types
============= */

/** Full `users` table row type (public schema). */
export type User = DbUserRow;

/** The per-option content preference fields that live in notification_preferences.
 *  The dashboard augments the `users` row with these (reconstructed from the
 *  table) so Vue controls can read `user.<field>`. */
type DashboardUserContentPrefs = Record<NotificationOptionFieldName, boolean>;

/** The `users` row augmented with per-option content prefs for the dashboard UI. */
export type DashboardUser = User & DashboardUserContentPrefs;
/** A user's tracked asset joined with canonical asset details. */
export type UserAsset = Pick<DbUserAssetRow, "symbol" | "created_at"> & {
	name: DbAssetRow["name"];
	type: AssetType;
	icon_url: DbAssetRow["icon_url"];
};

/** Snapshot of user notification settings used for quick comparisons/decisions.
 *
 * Account routing (`delivery_channel`) comes from the `users` row; content
 * toggles come from notification_preferences, reconstructed as a flat boolean
 * map (see `buildPreferenceSnapshot`). */
export type NotificationPreferencesSnapshot = Pick<
	User,
	| "market_scheduled_asset_price_enabled"
	| "delivery_channel"
	| "timezone"
	| "market_scheduled_asset_price_times"
	| "daily_notification_enabled"
	| "daily_notification_time"
	| "daily_notification_next_send_at"
	| "market_scheduled_asset_price_next_send_at"
	| "dismiss_timezone_mismatch_prompts"
	| "asset_events_last_analyst_sent_month"
> &
	Partial<Record<string, boolean>>;

/** Subset of notification preferences editable from the dashboard UI. */
export type NotificationPreferences = Pick<
	User,
	| "delivery_channel"
	| "market_scheduled_asset_price_times"
	| "market_scheduled_asset_price_next_send_at"
>;

/** Allowed update payload for the `users` table. */
export type UserUpdateInput = DbUserUpdate;
