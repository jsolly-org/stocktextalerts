import type { DeliveryChannelMode, NotificationOptionFieldName } from "../../lib/constants";
import type { PriceMoveThresholdUnit, UserAsset } from "../../lib/db/types";

export type InitialAsset = Pick<UserAsset, "symbol" | "name" | "type" | "icon_url">;

/** Per-symbol price-move alert threshold map (symbol → configured value + unit).
 *  A symbol absent from the map has no threshold (alerts off for that stock). */
export type PriceMoveThresholdMap = Record<string, { value: number; unit: PriceMoveThresholdUnit }>;

/** The update/current API's notificationPreferences payload as the dashboard
 *  consumes it. Per-option content fields derive from the option catalog. */
export type NotificationPreferencesData = {
	market_scheduled_asset_price_enabled: boolean;
	delivery_channel: DeliveryChannelMode;
	timezone: string;
	market_scheduled_asset_price_times: number[] | null;
	daily_notification_enabled: boolean;
	daily_notification_time: number | null;
	daily_notification_next_send_at: string | null;
	market_scheduled_asset_price_next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
} & Record<NotificationOptionFieldName, boolean>;
