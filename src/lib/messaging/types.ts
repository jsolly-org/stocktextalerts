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

export type UserRecord = Pick<
	DbUserRow,
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "timezone"
	| "scheduled_updates_enabled"
	| "next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
	| "show_change_percent"
	| "show_company_name"
	| "detailed_format"
> & {
	scheduled_update_times: number[] | null;
};

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
