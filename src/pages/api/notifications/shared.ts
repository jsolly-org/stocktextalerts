import { Temporal } from "@js-temporal/polyfill";
import type { Database } from "../../../lib/db/generated/database.types";
import type { AppSupabaseClient } from "../../../lib/db/supabase";

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

export function calculateNextSendAt(
	localMinutes: number,
	timezone: string,
	getCurrentTime: () => Date,
): Date | null {
	try {
		if (!Number.isFinite(localMinutes)) {
			return null;
		}

		const hours = Math.floor(localMinutes / 60);
		const minutes = localMinutes % 60;
		if (
			!Number.isInteger(hours) ||
			!Number.isInteger(minutes) ||
			hours < 0 ||
			hours > 23 ||
			minutes < 0 ||
			minutes > 59
		) {
			return null;
		}

		const now = getCurrentTime();
		const nowInstant = Temporal.Instant.from(now.toISOString());
		const nowZoned = nowInstant.toZonedDateTimeISO(timezone);

		let candidate = nowZoned.with({
			hour: hours,
			minute: minutes,
			second: 0,
			millisecond: 0,
			microsecond: 0,
			nanosecond: 0,
		});

		if (Temporal.ZonedDateTime.compare(candidate, nowZoned) <= 0) {
			candidate = candidate.add({ days: 1 });
		}

		return new Date(candidate.toInstant().epochMilliseconds);
	} catch (error) {
		console.error("Failed to calculate next_send_at", {
			localMinutes,
			timezone,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

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
		console.error("Failed to record notification:", error);
		return false;
	}

	return true;
}
