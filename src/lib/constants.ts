import type { PrefChannel } from "./types";

/* =============
Notification channels
============= */

/** Every delivery channel, in canonical order (mirrors the DB `delivery_method` enum). */
export const PREF_CHANNELS = ["email", "sms", "telegram"] as const satisfies readonly PrefChannel[];

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
	priceTargets: "price-targets",
} as const;

type DashboardSection = keyof typeof DASHBOARD_SECTION_IDS;

/** Hash links (e.g. `#watchlist`) for each dashboard section. */
export const DASHBOARD_SECTION_HASHES: Record<DashboardSection, string> = {
	notificationChannels: `#${DASHBOARD_SECTION_IDS.notificationChannels}`,
	assets: `#${DASHBOARD_SECTION_IDS.assets}`,
	marketNotifications: `#${DASHBOARD_SECTION_IDS.marketNotifications}`,
	assetEvents: `#${DASHBOARD_SECTION_IDS.assetEvents}`,
	dailyNotifications: `#${DASHBOARD_SECTION_IDS.dailyNotifications}`,
	priceTargets: `#${DASHBOARD_SECTION_IDS.priceTargets}`,
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
