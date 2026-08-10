import type { Database } from "./db/generated/database.types";

/* =============
Delivery pipes
============= */

/** Outbound send/log channel (DB `delivery_method` enum) — email | telegram. */
export type DeliveryMethod = Database["public"]["Enums"]["delivery_method"];

/** Account-level routing mode (DB `delivery_channel_mode` enum). */
export type DeliveryChannelMode = Database["public"]["Enums"]["delivery_channel_mode"];

/**
 * Delivery channels selectable on the dashboard / notification-preferences form.
 * `lambda` is service-only (stock-buyer wakeup) and must not appear in UI.
 */
export const USER_SELECTABLE_DELIVERY_CHANNEL_MODES = [
	"email",
	"telegram",
	"disabled",
] as const satisfies ReadonlyArray<Exclude<DeliveryChannelMode, "lambda">>;

/* =============
Notification options — THE single authored source of the option taxonomy.

One structure defines every valid (notification_type, content) option:

  - object keys author the valid `notification_type` and `content` values;
  - `default` authors the new-user signup default for that content toggle;
  - `family` groups daily_notification facets and selects their form-field
    prefix (see NOTIFICATION_FAMILY_FIELD_PREFIX).

Account routing (email | telegram | disabled; plus service-only `lambda`) lives
on `users.delivery_channel`, not on each option. Dashboard forms use
USER_SELECTABLE_DELIVERY_CHANNEL_MODES so users cannot pick `lambda`. Everything
else derives from this value or is drift-checked against it: the TS unions
below, the flat NOTIFICATION_PREFERENCE_CATALOG (and each option's form
fieldName), the notification-preferences form schema, signup defaults
(buildDefaultPreferenceRows) and the local seed, dashboard field bindings, and
the `notification_options` DB table enforcing the same pairs via FK (checked by
`npm run check:option-catalog` inside db:reset). Add, remove, or rename an
option HERE — a new option also needs a migration inserting its
`notification_options` row, which the drift check demands loudly.

Facet-less types must use exactly one `""` content key.
============= */

/** Daily-notification facet families → their dashboard form-field prefix. */
const NOTIFICATION_FAMILY_FIELD_PREFIX = {
	digest: "daily_digest",
	asset_events: "asset_events",
} as const;

/** A daily_notification facet family (digest vs asset-events pipelines). */
export type NotificationFamily = keyof typeof NOTIFICATION_FAMILY_FIELD_PREFIX;

export const NOTIFICATION_OPTION_MATRIX = {
	daily_notification: {
		prices: { family: "digest", default: true },
		top_movers: { family: "digest", default: false },
		news: { family: "digest", default: false },
		rumors: { family: "digest", default: false },
		prediction_markets: { family: "digest", default: false },
		calendar: { family: "asset_events", default: false },
		ipo: { family: "asset_events", default: false },
		analyst: { family: "asset_events", default: false },
		insider: { family: "asset_events", default: false },
		filings: { family: "asset_events", default: false },
		short_interest: { family: "asset_events", default: false },
	},
	market_scheduled_asset_price: { "": { default: false } },
	price_move_alerts: { "": { default: false } },
} as const satisfies {
	daily_notification: Record<string, { family: NotificationFamily; default: boolean }>;
} & Record<string, Record<string, { family?: NotificationFamily; default: boolean }>>;

type OptionMatrix = typeof NOTIFICATION_OPTION_MATRIX;

/** Notification types stored in `notification_preferences.notification_type`. */
export type NotificationPreferenceType = keyof OptionMatrix;

type DailyOptionMatrix = OptionMatrix["daily_notification"];

/** All content facets in the unified daily notification. */
export type DailyNotificationContent = keyof DailyOptionMatrix;

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
> = C extends ""
	? `${T}_include`
	: OptionMatrix[T][C] extends { family: infer F extends NotificationFamily }
		? `${(typeof NOTIFICATION_FAMILY_FIELD_PREFIX)[F]}_include_${C}`
		: never;

/** Every per-option boolean form field, derived from the matrix. */
export type NotificationOptionFieldName = {
	[T in NotificationPreferenceType]: {
		[C in keyof OptionMatrix[T] & string]: OptionFieldNameFor<T, C>;
	}[keyof OptionMatrix[T] & string];
}[NotificationPreferenceType];

/** The dashboard/API form-field name for an option (runtime twin of NotificationOptionFieldName). */
function notificationOptionFieldName(
	type: NotificationPreferenceType,
	content: DailyNotificationContent | FacetlessContent,
): NotificationOptionFieldName {
	if (content === "") {
		return `${type}_include` as NotificationOptionFieldName;
	}
	const family = NOTIFICATION_OPTION_MATRIX.daily_notification[content].family;
	return `${NOTIFICATION_FAMILY_FIELD_PREFIX[family]}_include_${content}` as NotificationOptionFieldName;
}

/** One flat catalog entry: a valid (type, content) option, its new-user
 *  default, its facet family (daily_notification only), and its form field name. */
export type FacetCatalogEntry = {
	notification_type: NotificationPreferenceType;
	content: DailyNotificationContent | FacetlessContent;
	default: boolean;
	family?: NotificationFamily;
	fieldName: NotificationOptionFieldName;
};

/** Flat catalog derived from the matrix: one entry per valid option. */
export const NOTIFICATION_PREFERENCE_CATALOG: readonly FacetCatalogEntry[] = Object.entries(
	NOTIFICATION_OPTION_MATRIX,
).flatMap(([type, contents]) =>
	Object.entries(contents).map(([content, option]) => {
		const notification_type = type as NotificationPreferenceType;
		const facet = content as DailyNotificationContent | FacetlessContent;
		return {
			notification_type,
			content: facet,
			default: option.default,
			...("family" in option ? { family: option.family as NotificationFamily } : {}),
			fieldName: notificationOptionFieldName(notification_type, facet),
		};
	}),
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
Price-move alerts
============= */

/** Default threshold applied when the user clicks "Set Threshold" on an unset stock.
 *  Expressed as a percent move. */
export const DEFAULT_PRICE_MOVE_THRESHOLD_PERCENT = 5;

/** Smallest per-stock threshold accepted (1% or $1). Whole numbers only —
 *  matches the DB CHECK (`threshold_value >= 1 AND = trunc(...)`) and the
 *  HTML `min` / `step=1` so spinners and typed input can't land invalid values. */
export const MIN_PRICE_MOVE_THRESHOLD = 1;

/** Largest per-stock thresholds accepted (guard fat-finger input). Percent caps
 *  at a full-day double; dollar allows large single-day moves on high-priced
 *  names. The DB enforces whole numbers >= 1; these ceilings are app-only. */
export const MAX_PRICE_MOVE_PERCENT_THRESHOLD = 100;
export const MAX_PRICE_MOVE_DOLLAR_THRESHOLD = 100_000;

/* =============
Assets
============= */

/** Max length for asset symbols; must match assets.symbol VARCHAR(n) in DB. */
export const ASSET_SYMBOL_MAX_LENGTH = 10;

/* =============
Auth
============= */

/**
 * Pure registration-gate decision — fails CLOSED. Registration opens only on an explicit
 * `true` override or a positive local/CI/test signal: a dev/test `NODE_ENV`, or the
 * `MODE=test` our Playwright dev *and* preview servers run under (see playwright*.config.ts).
 * Every real deploy (NODE_ENV=production, no test MODE) resolves closed — even if a Vercel
 * system var is missing — so a config glitch can never silently reopen public signups.
 * Exported so the truth table can be unit-tested without env mutation.
 */
export function resolveRegistrationEnabled(env: {
	registrationEnabled: string | undefined;
	nodeEnv: string | undefined;
	mode: string | undefined;
}): boolean {
	const override = env.registrationEnabled?.trim().toLowerCase();
	if (override === "true") {
		return true;
	}
	if (override === "false") {
		return false;
	}
	return env.nodeEnv === "development" || env.nodeEnv === "test" || env.mode === "test";
}

/**
 * Registration gate. Open in local dev / CI / tests (so the multi-user signup + approval
 * flow stays exercised — the app remains architecturally multi-user) and closed on every
 * deployed environment: this is a private two-person app. Set `REGISTRATION_ENABLED=true`
 * on a deploy to reopen signups.
 *
 * `process` is guarded because this module is imported by client Vue islands where
 * `process` is undefined (see DAILY_DISPATCH_BATCH_SIZE). No island reads this flag; the
 * browser value is inert and, like every other path, fails closed.
 */
export const REGISTRATION_ENABLED =
	typeof process === "undefined"
		? false
		: resolveRegistrationEnabled({
				registrationEnabled: process.env.REGISTRATION_ENABLED,
				nodeEnv: process.env.NODE_ENV,
				mode: process.env.MODE,
			});

/** Minimum password length enforced at the application level. */
export const MIN_PASSWORD_LENGTH = 8;

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

/** Daily fan-out batch size for digest dispatch. Override via SCHEDULE_DAILY_DISPATCH_BATCH_SIZE. */
export const DAILY_DISPATCH_BATCH_SIZE = (() => {
	// Guard `process` so this shared module stays browser-safe: it's imported by
	// client Vue islands (e.g. DEFAULT_TIMEZONE) where `process` is undefined, and
	// this server-only tuning knob would otherwise throw on import and break hydration.
	const raw =
		typeof process !== "undefined" ? process.env.SCHEDULE_DAILY_DISPATCH_BATCH_SIZE : undefined;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();
