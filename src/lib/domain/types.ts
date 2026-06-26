/**
 * Application-level domain types that narrow generated Supabase primitives.
 *
 * Postgres check constraints and enums are not reflected in `database.types.ts`;
 * use these aliases at app boundaries. Columns listed under "Migration candidates"
 * below could become Postgres enums/domains so generated types narrow at the source.
 */

declare const brand: unique symbol;
type Brand<B extends string> = { readonly [brand]: B };

/* =============
Asset
============= */

/** Normalized asset class (`assets.type` CHECK: stock | etf). */
export type AssetType = "stock" | "etf";

const ASSET_TYPES = ["stock", "etf"] as const satisfies readonly AssetType[];

function parseAssetType(value: string): AssetType | null {
	return ASSET_TYPES.includes(value as AssetType) ? (value as AssetType) : null;
}

/** Assert asset type at DB read boundaries (constraint-backed). */
export function assertAssetType(value: string): AssetType {
	const parsed = parseAssetType(value);
	if (!parsed) {
		throw new Error(`Invalid asset type: ${value}`);
	}
	return parsed;
}

/* =============
Time & schedule
============= */

/** Hour component 0–23. */
export type Hour24 = number & Brand<"Hour24">;
/** Minute component 0–59. */
export type MinuteOfHour = number & Brand<"MinuteOfHour">;
/** Second component 0–59. */
export type SecondOfMinute = number & Brand<"SecondOfMinute">;
/** Minutes since local midnight, 0–1439 (`scheduled_minutes`, `daily_digest_time`, etc.). */
export type MinuteOfDay = number & Brand<"MinuteOfDay">;

export function asHour24(n: number): Hour24 | null {
	return Number.isInteger(n) && n >= 0 && n <= 23 ? (n as Hour24) : null;
}

export function asMinuteOfHour(n: number): MinuteOfHour | null {
	return Number.isInteger(n) && n >= 0 && n <= 59 ? (n as MinuteOfHour) : null;
}

export function asSecondOfMinute(n: number): SecondOfMinute | null {
	return Number.isInteger(n) && n >= 0 && n <= 59 ? (n as SecondOfMinute) : null;
}

export function asMinuteOfDay(n: number): MinuteOfDay | null {
	return Number.isInteger(n) && n >= 0 && n <= 1439 ? (n as MinuteOfDay) : null;
}

/** Assert minute-of-day at scheduling boundaries (DB CHECK 0–1439). */
export function assertMinuteOfDay(n: number): MinuteOfDay {
	const parsed = asMinuteOfDay(n);
	if (parsed === null) {
		throw new Error(`Invalid minute-of-day: ${n}`);
	}
	return parsed;
}

/* =============
Dates & timestamps
============= */

/** ISO calendar date `YYYY-MM-DD` (`scheduled_date`, `event_date`, etc.). */
export type IsoDateString = string & Brand<"IsoDateString">;
/** ISO-8601 UTC timestamp (`next_send_at`, `scheduled_for`, etc.). */
export type IsoTimestampString = string & Brand<"IsoTimestampString">;
/** `YYYY-MM` month key (`asset_events_last_analyst_sent_month`). */
export type YearMonthString = string & Brand<"YearMonthString">;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

function asIsoDateString(value: string): IsoDateString | null {
	return ISO_DATE_RE.test(value) ? (value as IsoDateString) : null;
}

function asYearMonthString(value: string): YearMonthString | null {
	return YEAR_MONTH_RE.test(value) ? (value as YearMonthString) : null;
}

export function assertIsoDateString(value: string): IsoDateString {
	const parsed = asIsoDateString(value);
	if (!parsed) {
		throw new Error(`Invalid ISO date: ${value}`);
	}
	return parsed;
}

export function assertYearMonthString(value: string): YearMonthString {
	const parsed = asYearMonthString(value);
	if (!parsed) {
		throw new Error(`Invalid year-month: ${value}`);
	}
	return parsed;
}

/* =============
DB wrapper aliases (migration candidates)
============= */

/**
 * Migration candidates — app wrappers until converted to Postgres enums:
 * - `price_targets.direction` → "above" | "below"
 * - `users.market_asset_price_alert_move_size` → "significant" | "extreme"
 * - `market_asset_price_alert_cooldowns.delivery_status` → "reserved" | "finalized"
 * - `staged_notifications.notification_type` → align with StagedNotificationType + drop stale `market`
 * - `assets.type` → asset_type enum (AssetType already enforced by CHECK)
 */
