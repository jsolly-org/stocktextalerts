/** A delivery channel (mirrors the DB `delivery_method` enum). */
export type PrefChannel = "email" | "sms" | "telegram";

/** Notification types stored in `notification_preferences.notification_type`. */
export type NotificationPreferenceType =
	| "daily_digest"
	| "asset_events"
	| "market_asset_price_alerts"
	| "market_scheduled_asset_price"
	| "price_move_alerts"
	| "price_targets";

export type DailyDigestContent = "prices" | "top_movers" | "news" | "rumors";
export type AssetEventsContent = "calendar" | "ipo" | "analyst" | "insider";
/** Facet-less notification types use empty content. */
export type FacetlessContent = "";

export type FacetlessNotificationType = Exclude<
	NotificationPreferenceType,
	"daily_digest" | "asset_events"
>;

type PrefRowBase = {
	channel: PrefChannel;
	enabled: boolean;
};

type DailyDigestPrefRow = PrefRowBase & {
	notification_type: "daily_digest";
	content: DailyDigestContent;
};

type AssetEventsPrefRow = PrefRowBase & {
	notification_type: "asset_events";
	content: AssetEventsContent;
};

type FacetlessPrefRow = PrefRowBase & {
	notification_type: FacetlessNotificationType;
	content: FacetlessContent;
};

/** A single notification-preference row (subset used by eligibility/reads). */
export type PrefRow = DailyDigestPrefRow | AssetEventsPrefRow | FacetlessPrefRow;
