import { Constants } from "../db/generated/database.types";
import type { FormSchema } from "../forms/schema";

/** Form schema for the notification-preferences update route. */
export const NOTIFICATION_PREFERENCES_SCHEMA = {
	market_scheduled_asset_price_enabled: { type: "boolean" },
	email_notifications_enabled: { type: "boolean" },
	sms_notifications_enabled: { type: "boolean" },
	timezone: { type: "timezone" },
	market_scheduled_asset_price_times: { type: "json_string_array" },
	daily_digest_time: { type: "time" },
	daily_digest_include_prices_email: { type: "boolean" },
	daily_digest_include_prices_sms: { type: "boolean" },
	daily_digest_include_top_movers_email: { type: "boolean" },
	daily_digest_include_top_movers_sms: { type: "boolean" },
	daily_digest_include_news_email: { type: "boolean" },
	daily_digest_include_rumors_email: { type: "boolean" },
	market_scheduled_asset_price_include_email: { type: "boolean" },
	market_scheduled_asset_price_include_sms: { type: "boolean" },
	asset_events_include_calendar_email: { type: "boolean" },
	asset_events_include_calendar_sms: { type: "boolean" },
	asset_events_include_ipo_email: { type: "boolean" },
	asset_events_include_ipo_sms: { type: "boolean" },
	asset_events_include_analyst_email: { type: "boolean" },
	asset_events_include_analyst_sms: { type: "boolean" },
	asset_events_include_insider_email: { type: "boolean" },
	asset_events_include_insider_sms: { type: "boolean" },
	market_asset_price_alerts_enabled: { type: "boolean" },
	market_asset_price_alerts_include_email: { type: "boolean" },
	market_asset_price_alerts_include_sms: { type: "boolean" },
	market_asset_price_alert_move_size: {
		type: "enum",
		values: Constants.public.Enums.alert_move_size,
	},
	price_move_alerts_include_email: { type: "boolean" },
	price_move_alerts_include_sms: { type: "boolean" },
	price_targets_include_email: { type: "boolean" },
	price_targets_include_sms: { type: "boolean" },
	// Telegram per-option prefs. No legacy `users` columns exist for these — they
	// persist to `notification_preferences` (channel='telegram'), not the users table.
	daily_digest_include_prices_telegram: { type: "boolean" },
	daily_digest_include_news_telegram: { type: "boolean" },
	daily_digest_include_rumors_telegram: { type: "boolean" },
	daily_digest_include_top_movers_telegram: { type: "boolean" },
	asset_events_include_analyst_telegram: { type: "boolean" },
	asset_events_include_calendar_telegram: { type: "boolean" },
	asset_events_include_insider_telegram: { type: "boolean" },
	asset_events_include_ipo_telegram: { type: "boolean" },
	market_asset_price_alerts_include_telegram: { type: "boolean" },
	market_scheduled_asset_price_include_telegram: { type: "boolean" },
	price_move_alerts_include_telegram: { type: "boolean" },
	price_targets_include_telegram: { type: "boolean" },
} as const satisfies FormSchema;

/** SMS facet form fields → their (notification_type, content) row key, used to
 *  enforce the sms_opted_out / phone-required guard against the table rows. */
export const SMS_INCLUDE_FIELD_TARGETS: Record<
	string,
	{ notification_type: string; content: string }
> = {
	market_scheduled_asset_price_include_sms: {
		notification_type: "market_scheduled_asset_price",
		content: "",
	},
	asset_events_include_calendar_sms: {
		notification_type: "daily_notification",
		content: "calendar",
	},
	asset_events_include_ipo_sms: { notification_type: "daily_notification", content: "ipo" },
	asset_events_include_analyst_sms: {
		notification_type: "daily_notification",
		content: "analyst",
	},
	asset_events_include_insider_sms: {
		notification_type: "daily_notification",
		content: "insider",
	},
	market_asset_price_alerts_include_sms: {
		notification_type: "market_asset_price_alerts",
		content: "",
	},
	price_move_alerts_include_sms: { notification_type: "price_move_alerts", content: "" },
	price_targets_include_sms: { notification_type: "price_targets", content: "" },
	daily_digest_include_top_movers_sms: {
		notification_type: "daily_notification",
		content: "top_movers",
	},
};

export const SMS_INCLUDE_FIELDS = Object.keys(SMS_INCLUDE_FIELD_TARGETS);
