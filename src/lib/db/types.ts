import type { NotificationOptionFieldName } from "../constants";
import type { AssetType } from "../types";
import { Constants, type Database } from "./generated/database.types";

/* =============
Enum aliases (Postgres enums)
============= */

export type StagedNotificationType = Database["public"]["Enums"]["staged_notification_type"];

/** Unit a per-stock price-move threshold is expressed in (percent vs absolute dollars). */
export type PriceMoveThresholdUnit = Database["public"]["Enums"]["price_move_threshold_unit"];

/** Narrow unknown input (API bodies) to a valid price-move threshold unit. */
export function isPriceMoveThresholdUnit(value: unknown): value is PriceMoveThresholdUnit {
	return (
		typeof value === "string" &&
		(Constants.public.Enums.price_move_threshold_unit as readonly string[]).includes(value)
	);
}

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

/** Every email option field name, derived from the option catalog. */
export type EmailOptionFieldName = Extract<NotificationOptionFieldName, `${string}_email`>;

/** The per-option email preference fields that used to be `users` columns
 *  and now live in notification_preferences. The dashboard augments the `users`
 *  row with these (reconstructed from the table) so the existing per-option Vue
 *  controls keep reading `user.<field>`. */
type DashboardUserChannelPrefs = Record<EmailOptionFieldName, boolean>;

/** The `users` row augmented with per-option email prefs for the dashboard UI. */
export type DashboardUser = User & DashboardUserChannelPrefs;
/** A user's tracked asset joined with canonical asset details. */
export type UserAsset = Pick<DbUserAssetRow, "symbol" | "created_at"> & {
	name: DbAssetRow["name"];
	type: AssetType;
	icon_url: DbAssetRow["icon_url"];
};

/** Snapshot of user notification settings used for quick comparisons/decisions.
 *
 * Channel/feature-level columns come from the `users` row; per-option channel
 * facets (`*_include_*`) come from notification_preferences, reconstructed as a
 * flat boolean map (see `buildChannelPreferenceSnapshot`). */
export type NotificationPreferencesSnapshot = Pick<
	User,
	| "market_scheduled_asset_price_enabled"
	| "email_notifications_enabled"
	| "timezone"
	| "market_scheduled_asset_price_times"
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
	| "email_notifications_enabled"
	| "market_scheduled_asset_price_times"
	| "market_scheduled_asset_price_next_send_at"
>;

/** Allowed update payload for the `users` table. */
export type UserUpdateInput = DbUserUpdate;
