import type { Database } from "./db/generated/database.types";
import { Constants } from "./db/generated/database.types";

/* =============
Notification channels
============= */

type DeliveryChannel = Database["public"]["Enums"]["delivery_method"];

/** Every delivery channel, in canonical order (derived from the DB `delivery_method` enum). */
export const PREF_CHANNELS = Constants.public.Enums.delivery_method;

/* =============
Notification options — THE single authored source of the option taxonomy.

One structure defines every valid (notification_type, content, channel) option:

  - object keys author the valid `notification_type` and `content` values;
  - `channels` keys author which delivery channels the option exists on —
    news/rumors have no `sms` key because that combo is INVALID, not disabled;
  - `channels` values author the new-user signup default;
  - `family` groups daily_notification facets and selects their form-field
    prefix (see NOTIFICATION_FAMILY_FIELD_PREFIX).

Everything else derives from this value or is drift-checked against it: the TS
unions below, the flat NOTIFICATION_PREFERENCE_CATALOG (and each option's form
fieldName), the notification-preferences form schema, the SMS opt-out guard,
signup defaults (buildDefaultPreferenceRows) and the local seed, dashboard
field bindings, and the `notification_options` DB table enforcing the same
triples via FK (checked by `npm run check:option-catalog` inside db:reset).
Add, remove, or rename an option HERE — a new option also needs a migration
inserting its `notification_options` row, which the drift check demands loudly.

Facet-less types must use exactly one `""` content key.
============= */

/** Per-channel presence (= combo validity) and new-user default for one option. */
type OptionChannelDefaults = Partial<Record<DeliveryChannel, boolean>>;

/** Daily-notification facet families → their dashboard form-field prefix. */
const NOTIFICATION_FAMILY_FIELD_PREFIX = {
	digest: "daily_digest",
	asset_events: "asset_events",
} as const;

/** A daily_notification facet family (digest vs asset-events pipelines). */
export type NotificationFamily = keyof typeof NOTIFICATION_FAMILY_FIELD_PREFIX;

export const NOTIFICATION_OPTION_MATRIX = {
	daily_notification: {
		prices: { family: "digest", channels: { email: true, sms: true, telegram: false } },
		top_movers: { family: "digest", channels: { email: false, sms: false, telegram: false } },
		news: { family: "digest", channels: { email: false, telegram: false } },
		rumors: { family: "digest", channels: { email: false, telegram: false } },
		calendar: { family: "asset_events", channels: { email: false, sms: false, telegram: false } },
		ipo: { family: "asset_events", channels: { email: false, sms: false, telegram: false } },
		analyst: { family: "asset_events", channels: { email: false, sms: false, telegram: false } },
		insider: { family: "asset_events", channels: { email: false, sms: false, telegram: false } },
	},
	market_asset_price_alerts: { "": { channels: { email: false, sms: false, telegram: false } } },
	market_scheduled_asset_price: { "": { channels: { email: false, sms: false, telegram: false } } },
	price_move_alerts: { "": { channels: { email: false, sms: false, telegram: false } } },
} as const satisfies {
	daily_notification: Record<
		string,
		{ family: NotificationFamily; channels: OptionChannelDefaults }
	>;
} & Record<
	string,
	Record<string, { family?: NotificationFamily; channels: OptionChannelDefaults }>
>;

type OptionMatrix = typeof NOTIFICATION_OPTION_MATRIX;

/** Notification types stored in `notification_preferences.notification_type`. */
export type NotificationPreferenceType = keyof OptionMatrix;

type DailyOptionMatrix = OptionMatrix["daily_notification"];

/** All content facets in the unified daily notification. */
export type DailyNotificationContent = keyof DailyOptionMatrix;

/** Digest-family facets of the daily notification. */
export type DailyDigestContent = {
	[C in DailyNotificationContent]: DailyOptionMatrix[C]["family"] extends "digest" ? C : never;
}[DailyNotificationContent];

/** Asset-event-family facets of the daily notification. */
export type AssetEventsContent = {
	[C in DailyNotificationContent]: DailyOptionMatrix[C]["family"] extends "asset_events"
		? C
		: never;
}[DailyNotificationContent];

/** Facet-less notification types use empty content. */
export type FacetlessContent = "";

export type FacetlessNotificationType = Exclude<NotificationPreferenceType, "daily_notification">;

/** The form-field name for one option (family prefix for daily facets). */
type OptionFieldNameFor<
	T extends NotificationPreferenceType,
	C extends keyof OptionMatrix[T] & string,
	Ch extends string,
> = C extends ""
	? `${T}_include_${Ch}`
	: OptionMatrix[T][C] extends { family: infer F extends NotificationFamily }
		? `${(typeof NOTIFICATION_FAMILY_FIELD_PREFIX)[F]}_include_${C}_${Ch}`
		: never;

type OptionChannelsOf<
	T extends NotificationPreferenceType,
	C extends keyof OptionMatrix[T],
> = OptionMatrix[T][C] extends { channels: infer Chs } ? Chs : never;

/** Every per-option boolean form field, derived from the matrix. */
export type NotificationOptionFieldName = {
	[T in NotificationPreferenceType]: {
		[C in keyof OptionMatrix[T] & string]: {
			[Ch in keyof OptionChannelsOf<T, C> & string]: OptionFieldNameFor<T, C, Ch>;
		}[keyof OptionChannelsOf<T, C> & string];
	}[keyof OptionMatrix[T] & string];
}[NotificationPreferenceType];

/** The dashboard/API form-field name for an option (runtime twin of NotificationOptionFieldName). */
function notificationOptionFieldName(
	type: NotificationPreferenceType,
	content: DailyNotificationContent | FacetlessContent,
	channel: DeliveryChannel,
): NotificationOptionFieldName {
	if (content === "") {
		return `${type}_include_${channel}` as NotificationOptionFieldName;
	}
	const family = NOTIFICATION_OPTION_MATRIX.daily_notification[content].family;
	return `${NOTIFICATION_FAMILY_FIELD_PREFIX[family]}_include_${content}_${channel}` as NotificationOptionFieldName;
}

/** One flat catalog entry: a valid (type, content, channel) option, its new-user
 *  default, its facet family (daily_notification only), and its form field name. */
export type FacetCatalogEntry = {
	notification_type: NotificationPreferenceType;
	content: DailyNotificationContent | FacetlessContent;
	channel: DeliveryChannel;
	default: boolean;
	family?: NotificationFamily;
	fieldName: NotificationOptionFieldName;
};

/** Flat catalog derived from the matrix: one entry per valid option. */
export const NOTIFICATION_PREFERENCE_CATALOG: readonly FacetCatalogEntry[] = Object.entries(
	NOTIFICATION_OPTION_MATRIX,
).flatMap(([type, contents]) =>
	Object.entries(contents).flatMap(([content, option]) =>
		Object.entries(option.channels).map(([channel, defaultEnabled]) => {
			const notification_type = type as NotificationPreferenceType;
			const facet = content as DailyNotificationContent | FacetlessContent;
			const prefChannel = channel as DeliveryChannel;
			return {
				notification_type,
				content: facet,
				channel: prefChannel,
				default: defaultEnabled as boolean,
				...("family" in option ? { family: option.family as NotificationFamily } : {}),
				fieldName: notificationOptionFieldName(notification_type, facet, prefChannel),
			};
		}),
	),
);

// Guard the one authoring mistake the type system can't catch: a faceted
// non-daily type whose content collides with a daily facet would derive a
// DUPLICATE fieldName, silently misdirecting that option's form writes.
// Fail at module load instead.
if (
	new Set(NOTIFICATION_PREFERENCE_CATALOG.map((e) => e.fieldName)).size !==
	NOTIFICATION_PREFERENCE_CATALOG.length
) {
	throw new Error("NOTIFICATION_OPTION_MATRIX derives duplicate form field names");
}

/* =============
Assets
============= */

/** Max length for asset symbols; must match assets.symbol VARCHAR(n) in DB. */
export const ASSET_SYMBOL_MAX_LENGTH = 10;

/* =============
Auth
============= */

/** Set to true to allow new account registrations. */
export const REGISTRATION_ENABLED = true;

/** Minimum password length enforced at the application level. */
export const MIN_PASSWORD_LENGTH = 8;

const VERIFICATION_EXPIRATION_MINUTES = 10;
/** Verification code lifetime in milliseconds. */
export const VERIFICATION_EXPIRATION_MS = VERIFICATION_EXPIRATION_MINUTES * 60 * 1000;

const VERIFICATION_RESEND_COOLDOWN_SECONDS = 60;
/** Minimum time between verification-code sends (milliseconds). */
export const VERIFICATION_RESEND_COOLDOWN_MS = VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000;

/* =============
Dashboard links
============= */

/** Section id fragments used for dashboard navigation and deep links. */
export const DASHBOARD_SECTION_IDS = {
	notificationChannels: "notification-channels",
	assets: "watchlist",
	marketNotifications: "market-notifications",
	assetEvents: "asset-events-notifications",
	dailyNotifications: "daily-notifications",
} as const;

type DashboardSection = keyof typeof DASHBOARD_SECTION_IDS;

/** Hash links (e.g. `#watchlist`) for each dashboard section. */
export const DASHBOARD_SECTION_HASHES: Record<DashboardSection, string> = {
	notificationChannels: `#${DASHBOARD_SECTION_IDS.notificationChannels}`,
	assets: `#${DASHBOARD_SECTION_IDS.assets}`,
	marketNotifications: `#${DASHBOARD_SECTION_IDS.marketNotifications}`,
	assetEvents: `#${DASHBOARD_SECTION_IDS.assetEvents}`,
	dailyNotifications: `#${DASHBOARD_SECTION_IDS.dailyNotifications}`,
};

/* =============
US market session & notification scheduling
============= */

/** Default time (minutes since local midnight) for market updates. */
export const DEFAULT_MARKET_UPDATE_TIME_MINUTES = 9 * 60; // 9:00 AM local time (minutes since local midnight)

/** US market open time in ET (minutes since midnight). */
export const US_MARKET_OPEN_EASTERN_MINUTES = 9 * 60 + 30;
/** US market close time in ET (minutes since midnight). */
export const US_MARKET_CLOSE_EASTERN_MINUTES = 16 * 60; // 4:00 PM ET
/** 30 min before open — used as the default preset time for daily digests. */
export const US_BEFORE_OPEN_EASTERN_MINUTES = 9 * 60; // 9:00 AM ET
/** 30 min after open — used as the default preset time for scheduled price notifications. */
export const US_AFTER_OPEN_EASTERN_MINUTES = 10 * 60; // 10:00 AM ET
/** Earliest allowed scheduled price notification time in ET (minutes since midnight). 4:30 AM ET = pre-market entry + 30 min outer buffer. */
export const US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES = 4 * 60 + 30; // 4:30 AM ET, minute 270
/** Latest allowed scheduled price notification time in ET (minutes since midnight). 7:30 PM ET = after-hours close - 30 min outer buffer. */
export const US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES = 19 * 60 + 30; // 7:30 PM ET, minute 1170
/** IANA timezone for the US market session constants (ET). */
export const US_MARKET_TIMEZONE = "America/New_York";

/* =============
Time
============= */

/** Must match: users.timezone DEFAULT in initial_schema.sql */
export const DEFAULT_TIMEZONE = "America/New_York";

/* =============
Scheduler tuning
============= */

/** Daily fan-out batch size for digest dispatch/precompute. Override via SCHEDULE_DAILY_DISPATCH_BATCH_SIZE. */
export const DAILY_DISPATCH_BATCH_SIZE = (() => {
	// Guard `process` so this shared module stays browser-safe: it's imported by
	// client Vue islands (e.g. DEFAULT_TIMEZONE) where `process` is undefined, and
	// this server-only tuning knob would otherwise throw on import and break hydration.
	const raw =
		typeof process !== "undefined" ? process.env.SCHEDULE_DAILY_DISPATCH_BATCH_SIZE : undefined;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();
