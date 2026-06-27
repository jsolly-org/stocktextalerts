/**
 * Application-level types that narrow generated Supabase primitives.
 *
 * Branded scalars (dates, minutes) live here. Postgres enum-backed columns are
 * typed via `Database["public"]["Enums"]` in `src/lib/db/index.ts`.
 */

import type { Database } from "./db/generated/database.types";
import { Constants } from "./db/generated/database.types";

declare const brand: unique symbol;
type Brand<B extends string> = { readonly [brand]: B };

/* =============
Asset
============= */

/** Normalized asset class (`assets.type` enum). */
export type AssetType = Database["public"]["Enums"]["asset_type"];

/** Assert asset type at DB read boundaries. */
export function assertAssetType(value: string): AssetType {
	if (!(Constants.public.Enums.asset_type as readonly string[]).includes(value)) {
		throw new Error(`Invalid asset type: ${value}`);
	}
	return value as AssetType;
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

/** Composite key for a `scheduled_notifications` slot (local date + minute-of-day). */
export interface ScheduledSlotKey {
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
}
