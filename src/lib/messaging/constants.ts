import type {
	DailyNotificationContent,
	FacetlessContent,
	NotificationPreferenceType,
	PrefChannel,
} from "../types";

/* =============
Facet catalog: the canonical set of (notification_type, content, channel) options,
with the DEFAULT value a brand-new user gets. This drives signup defaults, the
dashboard ⇆ table translation, and the seed. It is the authored replacement for
the dropped column DEFAULTs.

Defaults (from the dropped column DEFAULTs):
  daily_digest prices email = true, daily_digest prices sms = true
  ALL OTHER facet rows = false
News/rumors are email + telegram only (no sms facet ever existed for them).
============= */

/** One catalog entry: a (type, content, channel) option and its new-user default. */
type FacetCatalogEntry = {
	notification_type: NotificationPreferenceType;
	content: DailyNotificationContent | FacetlessContent;
	channel: PrefChannel;
	default: boolean;
};

export const NOTIFICATION_PREFERENCE_CATALOG: readonly FacetCatalogEntry[] = [
	// daily_notification — unified daily slot (digest + asset events)
	{
		notification_type: "daily_notification",
		content: "prices",
		channel: "email",
		default: true,
	},
	{
		notification_type: "daily_notification",
		content: "prices",
		channel: "sms",
		default: true,
	},
	{
		notification_type: "daily_notification",
		content: "prices",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "top_movers",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "top_movers",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "top_movers",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "news",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "news",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "rumors",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "rumors",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "calendar",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "calendar",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "calendar",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "ipo",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "ipo",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "ipo",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "analyst",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "analyst",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "analyst",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "insider",
		channel: "email",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "insider",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "daily_notification",
		content: "insider",
		channel: "telegram",
		default: false,
	},
	// facet-less market/price types (content = "")
	{
		notification_type: "market_asset_price_alerts",
		content: "",
		channel: "email",
		default: false,
	},
	{
		notification_type: "market_asset_price_alerts",
		content: "",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "market_asset_price_alerts",
		content: "",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "market_scheduled_asset_price",
		content: "",
		channel: "email",
		default: false,
	},
	{
		notification_type: "market_scheduled_asset_price",
		content: "",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "market_scheduled_asset_price",
		content: "",
		channel: "telegram",
		default: false,
	},
	{
		notification_type: "price_move_alerts",
		content: "",
		channel: "email",
		default: false,
	},
	{
		notification_type: "price_move_alerts",
		content: "",
		channel: "sms",
		default: false,
	},
	{
		notification_type: "price_move_alerts",
		content: "",
		channel: "telegram",
		default: false,
	},
] as const;
