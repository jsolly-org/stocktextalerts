import type { Database } from "../db/generated/database.types";

export type DeliveryResult =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

export interface ProcessingStats {
	sent: boolean;
	logged: boolean;
	error?: string;
	errorCode?: string;
}

type DbUserRow = Database["public"]["Tables"]["users"]["Row"];

export interface FormatPreferences {
	show_change_percent: boolean;
	show_company_name: boolean;
	detailed_format: boolean;
}

type GrokRumorsPreferences = {
	daily_digest_include_news_email: boolean;
	daily_digest_include_rumors_email: boolean;
	last_grok_rumors_at: string | null;
	grok_window_start: string | null;
	grok_sends_in_window: number;
};

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
	| "sms_notifications_enabled"
	| "sms_opted_out"
	| "show_change_percent"
	| "show_company_name"
	| "detailed_format"
> & {
	market_scheduled_asset_price_enabled: boolean;
	market_scheduled_asset_price_include_email: boolean;
	market_scheduled_asset_price_include_sms: boolean;
	market_scheduled_asset_price_times: number[] | null;
	daily_digest_time: number | null;
	daily_digest_next_send_at: string | null;
	asset_events_include_earnings_email: boolean;
	asset_events_include_earnings_sms: boolean;
	asset_events_include_dividends_email: boolean;
	asset_events_include_dividends_sms: boolean;
	asset_events_include_splits_email: boolean;
	asset_events_include_splits_sms: boolean;
	asset_events_include_analyst_email: boolean;
	asset_events_include_analyst_sms: boolean;
	asset_events_include_insider_email: boolean;
	asset_events_include_insider_sms: boolean;
	asset_events_next_send_at: string | null;
	asset_events_last_analyst_sent_month: string | null;
} & GrokRumorsPreferences;

export type EmailUser = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	"id" | "email"
>;
export type SmsUser = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	"id" | "phone_country_code" | "phone_number"
>;

export type UserAssetRow = Pick<
	Database["public"]["Tables"]["user_assets"]["Row"],
	"symbol"
> & {
	name: Database["public"]["Tables"]["assets"]["Row"]["name"];
};
