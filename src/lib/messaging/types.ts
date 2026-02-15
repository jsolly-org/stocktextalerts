import type { Database } from "../db/generated/database.types";

/** Result of attempting to deliver a single notification (email or SMS). */
export type DeliveryResult =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

/** Per-notification processing metadata used for auditing/debugging. */
export interface ProcessingStats {
	sent: boolean;
	logged: boolean;
	error?: string;
	errorCode?: string;
}

type DbUserRow = Database["public"]["Tables"]["users"]["Row"];

/** User-controlled formatting toggles for rendered notifications. */
export interface FormatPreferences {
	show_sparklines: boolean;
}

type GrokRumorsPreferences = {
	daily_digest_include_news_email: boolean;
	daily_digest_include_rumors_email: boolean;
	last_grok_rumors_at: string | null;
	grok_window_start: string | null;
	grok_sends_in_window: number;
};

/** User fields required for notification delivery, scheduling, and formatting. */
export type UserRecord = Pick<
	DbUserRow,
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "timezone"
	| "market_scheduled_asset_price_next_send_at"
	| "email_notifications_enabled"
	| "sms_opted_out"
	| "show_sparklines"
> & {
	market_scheduled_asset_price_enabled: boolean;
	market_scheduled_asset_price_include_email: boolean;
	market_scheduled_asset_price_include_sms: boolean;
	market_scheduled_asset_price_times: number[] | null;
	daily_digest_time: number | null;
	daily_digest_next_send_at: string | null;
	asset_events_include_calendar_email: boolean;
	asset_events_include_calendar_sms: boolean;
	asset_events_include_ipo_email: boolean;
	asset_events_include_ipo_sms: boolean;
	asset_events_include_analyst_email: boolean;
	asset_events_include_analyst_sms: boolean;
	asset_events_include_insider_email: boolean;
	asset_events_include_insider_sms: boolean;
	asset_events_next_send_at: string | null;
	asset_events_last_analyst_sent_month: string | null;
	market_asset_price_alerts_include_sms: boolean;
} & GrokRumorsPreferences;

/** Minimal user shape needed to send email. */
export type EmailUser = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	"id" | "email"
>;
/** Minimal user shape needed to send SMS. */
export type SmsUser = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	"id" | "phone_country_code" | "phone_number"
>;

/** User asset joined with its canonical asset name. */
export type UserAssetRow = Pick<
	Database["public"]["Tables"]["user_assets"]["Row"],
	"symbol"
> & {
	name: Database["public"]["Tables"]["assets"]["Row"]["name"];
};
