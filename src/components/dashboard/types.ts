import type { AlertMoveSize, UserAsset } from "../../lib/db/types";

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

export type NotificationPreferencesData = {
	market_scheduled_asset_price_enabled: boolean;
	email_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	market_scheduled_asset_price_times: number[] | null;
	daily_notification_time: number | null;
	daily_notification_next_send_at: string | null;
	market_scheduled_asset_price_next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
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
	market_asset_price_alerts_enabled: boolean;
	market_asset_price_alerts_include_email: boolean;
	market_asset_price_alerts_include_sms: boolean;
	market_asset_price_alert_move_size: AlertMoveSize;
	price_move_alerts_include_email: boolean;
	price_move_alerts_include_sms: boolean;
	price_targets_include_email: boolean;
	price_targets_include_sms: boolean;
};
