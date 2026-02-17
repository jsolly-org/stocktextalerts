/** User column projection for market-scheduled queries. */
export const MARKET_SCHEDULED_USER_SELECT = `
	id,
	email,
	phone_country_code,
	phone_number,
	phone_verified,
	timezone,
	market_scheduled_asset_price_enabled,
	market_scheduled_asset_price_include_email,
	market_scheduled_asset_price_include_sms,
	market_scheduled_asset_price_times,
	daily_digest_time,
	daily_digest_next_send_at,
	market_scheduled_asset_price_next_send_at,
	email_notifications_enabled,
	sms_notifications_enabled,
	sms_opted_out,
	daily_digest_include_news_email,
	daily_digest_include_rumors_email,
	asset_events_include_calendar_email,
	asset_events_include_calendar_sms,
	asset_events_include_ipo_email,
	asset_events_include_ipo_sms,
	asset_events_include_analyst_email,
	asset_events_include_analyst_sms,
	asset_events_include_insider_email,
	asset_events_include_insider_sms,
	asset_events_next_send_at,
	asset_events_last_analyst_sent_month,
	market_asset_price_alerts_include_sms,
	last_grok_rumors_at,
	grok_window_start,
	grok_sends_in_window,
	show_sparklines
`;

/** Filter: user has at least one delivery channel for market-scheduled updates. */
export const HAS_DELIVERY_CHANNEL_OR =
	"and(email_notifications_enabled.eq.true,market_scheduled_asset_price_include_email.eq.true),and(sms_notifications_enabled.eq.true,market_scheduled_asset_price_include_sms.eq.true)";
