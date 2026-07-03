import type { AlertMoveSize, EmailSmsOptionFieldName, UserAsset } from "../../lib/db/types";

export type InitialAsset = Pick<UserAsset, "symbol" | "name" | "type" | "icon_url">;

/**
 * A single selectable channel inside the multiselect. `disabled` keeps the option
 * visible (so the user understands the channel exists) but blocks toggling, with
 * `disabledTitle` explaining why — mirroring the legacy per-channel checkbox hints.
 */
export interface ChannelOption {
	value: string;
	label: string;
	selected: boolean;
	disabled?: boolean;
	disabledTitle?: string;
}

/** The update/current API's notificationPreferences payload as the dashboard
 *  consumes it. Per-option email/sms fields derive from the option catalog. */
export type NotificationPreferencesData = {
	market_scheduled_asset_price_enabled: boolean;
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	market_scheduled_asset_price_times: number[] | null;
	daily_notification_time: number | null;
	daily_notification_next_send_at: string | null;
	market_scheduled_asset_price_next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
	market_asset_price_alerts_enabled: boolean;
	market_asset_price_alert_move_size: AlertMoveSize;
} & Record<EmailSmsOptionFieldName, boolean>;
