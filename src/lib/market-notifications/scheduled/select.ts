/** User column projection for market-scheduled queries (channel-level columns only;
 *  per-option facets live in notification_preferences, attached separately). */
export const MARKET_SCHEDULED_USER_SELECT = `
	id,
	email,
	phone_country_code,
	phone_number,
	phone_verified,
	timezone,
	use_24_hour_time,
	market_scheduled_asset_price_enabled,
	market_scheduled_asset_price_times,
	daily_notification_time,
	daily_notification_next_send_at,
	market_scheduled_asset_price_next_send_at,
	email_notifications_enabled,
	sms_notifications_enabled,
	sms_opted_out,
	asset_events_last_analyst_sent_month,
	telegram_chat_id,
	telegram_opted_out,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window
`;

/** Candidate filter: user has at least one usable delivery channel (email global on,
 *  SMS opted in + verified, or a linked Telegram chat). The per-option
 *  market_scheduled_asset_price facet is checked per-channel in process.ts. */
export const HAS_DELIVERY_CHANNEL_OR =
	"email_notifications_enabled.eq.true,and(sms_notifications_enabled.eq.true,phone_verified.eq.true),telegram_chat_id.not.is.null";
