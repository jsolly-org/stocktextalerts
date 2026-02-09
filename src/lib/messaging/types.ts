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
	daily_include_news_email: boolean;
	daily_include_rumors_email: boolean;
	daily_include_analyst_email: boolean;
	daily_include_insider_email: boolean;
	daily_include_analyst_sms: boolean;
	daily_include_insider_sms: boolean;
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
	| "next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "sms_opted_out"
	| "show_change_percent"
	| "show_company_name"
	| "detailed_format"
> & {
	price_notifications_enabled: boolean;
	price_include_email: boolean;
	price_include_sms: boolean;
	scheduled_update_times: number[] | null;
	only_notify_when_market_open: boolean;
	daily_only_notify_when_market_open: boolean;
	daily_delivery_time: number | null;
	daily_next_send_at: string | null;
	weekly_include_earnings_email: boolean;
	weekly_include_earnings_sms: boolean;
	weekly_include_dividends_email: boolean;
	weekly_include_dividends_sms: boolean;
	weekly_next_send_at: string | null;
	last_market_closed_skip_scheduled_at: string | null;
	last_market_closed_skip_recorded_at: string | null;
} & GrokRumorsPreferences;

export type EmailUser = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	"id" | "email"
>;
export type SmsUser = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	"id" | "phone_country_code" | "phone_number"
>;

export type UserStockRow = Pick<
	Database["public"]["Tables"]["user_stocks"]["Row"],
	"symbol"
> & {
	name: Database["public"]["Tables"]["stocks"]["Row"]["name"];
};
