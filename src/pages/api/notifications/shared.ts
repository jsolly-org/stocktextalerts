import type { Database } from "../../../lib/db/generated/database.types";
import type { AppSupabaseClient } from "../../../lib/db/supabase";
import { rootLogger } from "../../../lib/logging";

export type DeliveryMethod = Database["public"]["Enums"]["delivery_method"];
export type ScheduledNotificationType =
	Database["public"]["Enums"]["scheduled_notification_type"];
export type ScheduledNotificationStatus =
	Database["public"]["Enums"]["scheduled_notification_status"];

export type DeliveryResult =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

export type UserRecord = Pick<
	Database["public"]["Tables"]["users"]["Row"],
	| "id"
	| "email"
	| "phone_country_code"
	| "phone_number"
	| "phone_verified"
	| "sms_opted_out"
	| "timezone"
	| "daily_digest_enabled"
	| "daily_digest_notification_time"
	| "next_send_at"
	| "email_notifications_enabled"
	| "sms_notifications_enabled"
>;

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

export async function loadUserStocks(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<UserStockRow[]> {
	const { data: stocks, error } = await supabase
		.from("user_stocks")
		.select("symbol, stocks!inner(name)")
		.eq("user_id", userId);

	if (error) {
		throw error;
	}

	return stocks.map((stock) => ({
		symbol: stock.symbol,
		name: stock.stocks.name,
	}));
}

export async function recordNotification(
	supabase: AppSupabaseClient,
	insert: Database["public"]["Tables"]["notification_log"]["Insert"],
): Promise<boolean> {
	const { error } = await supabase.from("notification_log").insert(insert);

	if (error) {
		rootLogger.error(
			"Failed to record notification",
			{ user_id: insert.user_id ?? null },
			error,
		);
		return false;
	}

	return true;
}
