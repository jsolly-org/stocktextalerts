/**
 * Application-level types that narrow generated Supabase primitives.
 *
 * Branded scalars (dates, minutes) live here. Postgres enum-backed columns are
 * typed via `Database["public"]["Enums"]` in `src/lib/db/types.ts`.
 */

import type { MessageEntity } from "grammy/types";
import type { Database } from "./db/generated/database.types";
import { Constants } from "./db/generated/database.types";
import type { StagedNotificationType } from "./db/types";

declare const brand: unique symbol;
type Brand<B extends string> = { readonly [brand]: B };

/* =============
Type guards
============= */

/**
 * Narrow unknown to a non-null object. Arrays pass (typeof "object") — identical
 * to the inline checks this replaces; pair with Array.isArray where element shape
 * matters.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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

/* =============
Dates & timestamps
============= */

/** ISO calendar date `YYYY-MM-DD` (`scheduled_date`, `event_date`, etc.). */
export type IsoDateString = string & Brand<"IsoDateString">;
/** ISO-8601 UTC timestamp (`next_send_at`, `scheduled_for`, etc.). */
type IsoTimestampString = string & Brand<"IsoTimestampString">;
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

/* =============
Finnhub extras
============= */

export interface RecommendationTrend {
	buy: number;
	hold: number;
	sell: number;
	strongBuy: number;
	strongSell: number;
	period: string;
}

export interface InsiderTransaction {
	name: string;
	share: number;
	change: number;
	transactionType: string;
	transactionDate: string;
}

/** Minimal company-news item fields used in digests/sections. */
export interface CompanyNewsItem {
	headline: string;
	summary: string;
	datetime: number;
	url: string;
	source: string;
	/** Ticker symbols associated with this article (from API). */
	tickers: string[];
}

/* =============
Notification preferences
============= */

/** A delivery channel (mirrors the DB `delivery_method` enum). */
export type PrefChannel = "email" | "sms" | "telegram";

/** Notification types stored in `notification_preferences.notification_type`. */
export type NotificationPreferenceType =
	| "daily_notification"
	| "market_asset_price_alerts"
	| "market_scheduled_asset_price"
	| "price_move_alerts";

export type DailyDigestContent = "prices" | "top_movers" | "news" | "rumors";
export type AssetEventsContent = "calendar" | "ipo" | "analyst" | "insider";
/** All content facets in the unified daily notification. */
export type DailyNotificationContent = DailyDigestContent | AssetEventsContent;
/** Facet-less notification types use empty content. */
export type FacetlessContent = "";

export type FacetlessNotificationType = Exclude<NotificationPreferenceType, "daily_notification">;

type PrefRowBase = {
	channel: PrefChannel;
	enabled: boolean;
};

type DailyNotificationPrefRow = PrefRowBase & {
	notification_type: "daily_notification";
	content: DailyNotificationContent;
};

type FacetlessPrefRow = PrefRowBase & {
	notification_type: FacetlessNotificationType;
	content: FacetlessContent;
};

/** A single notification-preference row (subset used by eligibility/reads). */
export type PrefRow = DailyNotificationPrefRow | FacetlessPrefRow;

/* =============
User records
============= */

type DbUserRow = Database["public"]["Tables"]["users"]["Row"];

type GrokRumorsPreferences = {
	last_grok_rumors_at: string | null;
	grok_window_start: string | null;
	grok_sends_in_window: number;
};

/** User fields required for notification delivery, scheduling, and formatting.
 *
 * Per-option channel preferences live in `notification_preferences` (carried as
 * `prefs`), NOT on per-column flags. Channel-level enables (`email_notifications_enabled`,
 * etc.) stay on the users row. */
export type UserRecord = Pick<
	DbUserRow,
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "timezone"
	| "use_24_hour_time"
	| "market_scheduled_asset_price_next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "sms_opted_out"
> & {
	market_scheduled_asset_price_enabled: boolean;
	market_scheduled_asset_price_times: number[] | null;
	daily_notification_time: number | null;
	daily_notification_next_send_at: string | null;
	asset_events_last_analyst_sent_month: string | null;
	telegram_chat_id: number | null;
	telegram_opted_out: boolean;
	/** Per-option channel preferences (the single source of truth for all channels). */
	prefs: PrefRow[];
} & GrokRumorsPreferences;

/** A user row as selected from the DB, before batch-attaching `prefs`. */
export type UserRecordWithoutPrefs = Omit<UserRecord, "prefs">;

/** User asset joined with its canonical asset name. */
export type UserAssetRow = Pick<Database["public"]["Tables"]["user_assets"]["Row"], "symbol"> & {
	name: Database["public"]["Tables"]["assets"]["Row"]["name"];
	icon_url?: Database["public"]["Tables"]["assets"]["Row"]["icon_url"];
	icon_base64?: Database["public"]["Tables"]["assets"]["Row"]["icon_base64"];
};

/* =============
Market data
============= */

/**
 * Sentinel when Massive returned the ticker entry but no live trade exists for
 * the current session. Distinct from `null` (ticker missing from response).
 */
export const NO_SESSION_TRADE = "no_session_trade" as const;
export type NoSessionTrade = typeof NO_SESSION_TRADE;

/** A single intraday OHLC bar (`t` is ms since epoch). */
export interface IntradayCandle {
	o: number;
	h: number;
	l: number;
	c: number;
	t: number;
}

/** Result of extracting closes and timestamps from intraday bars. */
export interface IntradayBarsResult {
	closes: number[];
	timestamps: (number | null)[] | null;
	startTimestamp: number | null;
	endTimestamp: number | null;
	candles: IntradayCandle[] | null;
}

/** Single daily OHLCV bar extracted from Massive aggregates. */
export interface DailyOHLCVBar {
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
	tradingDate?: string;
}

interface AssetPrice {
	price: number;
	changePercent: number;
	timestamp?: number | null;
	prevClose?: number | null;
}

/** Quote fields used by movement alerts and snapshot persistence. */
export interface ExtendedAssetQuote extends AssetPrice {
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

/** Map of simple price quotes keyed by symbol. `null` = ticker missing (fetch fail / no live trade). */
export type AssetPriceMap = Map<string, AssetPrice | null>;
/** Map of extended quotes keyed by symbol. */
export type ExtendedQuoteMap = Map<string, ExtendedAssetQuote | null>;

export type MarketSession = "pre" | "regular" | "after" | "closed";
/** A session in which trading is actually happening (never "closed"). */
export type ActiveMarketSession = Exclude<MarketSession, "closed">;

/* =============
Delivery
============= */

/** Result of attempting to deliver a single notification (email or SMS). */
export type DeliveryResult =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

/** Per-notification processing metadata used for auditing/debugging. */
export type ProcessingStats =
	| { sent: true; logged: boolean }
	| { sent: false; logged: boolean; error: string; errorCode?: string };

/** Per-run delivery counters shared by every notification pipeline (one pair per channel). */
export interface ChannelDeliveryStats {
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
	telegramSent: number;
	telegramFailed: number;
	/** `notification_log` insert failures on an otherwise completed send. */
	logFailures: number;
}

/* =============
Timezone
============= */

export type TimezoneOption = Pick<
	Database["public"]["Tables"]["timezones"]["Row"],
	"value" | "label" | "display_order"
>;

/* =============
Staged notifications
============= */

interface StagedEmailContent {
	subject: string;
	text: string;
	html: string;
}

export type StagedSmsContent =
	| { messages: string[] }
	// Short-lived persisted JSON compatibility for rows staged before multipart SMS shipped.
	| { message: string };

/** Fully-rendered Telegram message: plain text plus out-of-band parse-mode entities. */
interface StagedTelegramContent {
	text: string;
	entities: MessageEntity[];
}

export interface StagedDailyData extends ScheduledSlotKey {
	type: "daily";
	email: StagedEmailContent | null;
	sms: StagedSmsContent | null;
	telegram: StagedTelegramContent | null;

	// Post-delivery metadata: these fields capture decisions made during
	// the pre-compute phase so the delivery phase can perform cleanup
	// (Grok counter updates, next_send_at advances, analyst month tracking)
	// without re-running eligibility checks or re-querying user preferences.
	grokAllowed: boolean;
	hasAnyAssetEventsOption: boolean;
	shouldUpdateAnalyst: boolean;
	analystMonth: YearMonthString | null;
}

export type StagedData = StagedDailyData;

export interface StagedNotificationRow {
	id: string;
	user_id: string;
	notification_type: StagedNotificationType;
	scheduled_for: IsoTimestampString;
	staged_at: IsoTimestampString;
	staged_data: StagedData;
}
