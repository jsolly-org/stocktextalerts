import type { AssetType } from "../types";
import type { Database } from "./generated/database.types";

/* =============
Enum aliases (Postgres enums)
============= */

export type AlertMoveSize = Database["public"]["Enums"]["alert_move_size"];
export type StagedNotificationType = Database["public"]["Enums"]["staged_notification_type"];

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

/** The 20 per-option email/sms preference fields that used to be `users` columns
 *  and now live in notification_preferences. The dashboard augments the `users`
 *  row with these (reconstructed from the table) so the existing per-option Vue
 *  controls keep reading `user.<field>`. */
interface DashboardUserChannelPrefs {
	daily_digest_include_prices_email: boolean;
	daily_digest_include_prices_sms: boolean;
	daily_digest_include_top_movers_email: boolean;
	daily_digest_include_top_movers_sms: boolean;
	daily_digest_include_news_email: boolean;
	daily_digest_include_rumors_email: boolean;
	market_scheduled_asset_price_include_email: boolean;
	market_scheduled_asset_price_include_sms: boolean;
	asset_events_include_calendar_email: boolean;
	asset_events_include_calendar_sms: boolean;
	asset_events_include_ipo_email: boolean;
	asset_events_include_ipo_sms: boolean;
	asset_events_include_analyst_email: boolean;
	asset_events_include_analyst_sms: boolean;
	asset_events_include_insider_email: boolean;
	asset_events_include_insider_sms: boolean;
	market_asset_price_alerts_include_email: boolean;
	market_asset_price_alerts_include_sms: boolean;
	price_move_alerts_include_email: boolean;
	price_move_alerts_include_sms: boolean;
}

/** The `users` row augmented with per-option email/sms prefs for the dashboard UI. */
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
	| "sms_notifications_enabled"
	| "sms_opted_out"
	| "phone_verified"
	| "timezone"
	| "market_scheduled_asset_price_times"
	| "daily_notification_time"
	| "daily_notification_next_send_at"
	| "market_scheduled_asset_price_next_send_at"
	| "dismiss_timezone_mismatch_prompts"
	| "asset_events_last_analyst_sent_month"
	| "market_asset_price_alerts_enabled"
	| "market_asset_price_alert_move_size"
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
