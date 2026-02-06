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

export type UserRecord = Pick<
	DbUserRow,
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "timezone"
	| "daily_digest_enabled"
	| "next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
> & {
	daily_digest_notification_times: number[] | null;
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
