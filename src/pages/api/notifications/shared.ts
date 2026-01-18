import { Temporal } from "@js-temporal/polyfill";
import type { Database } from "../../../lib/generated/database.types";
import type { AppSupabaseClient } from "../../../lib/supabase";
import type { User } from "../../../lib/users";

export type DeliveryMethod = Database["public"]["Enums"]["delivery_method"];
export type ScheduledNotificationType =
	Database["public"]["Enums"]["scheduled_notification_type"];

export type DeliveryResult =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

export interface NotificationLogEntry {
	userId: string;
	type: string;
	deliveryMethod: DeliveryMethod;
	messageDelivered: boolean;
	message?: string;
	error?: string;
	errorCode?: string;
}

export type UserRecord = Pick<
	User,
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

export type EmailUser = Pick<UserRecord, "id" | "email">;
export type SmsUser = Pick<
	UserRecord,
	"id" | "phone_country_code" | "phone_number"
>;

export interface UserStockRow {
	symbol: string;
	name: string;
}

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

		if (timezone.trim() === "") {
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

	return (stocks ?? []).map((stock) => ({
		symbol: stock.symbol,
		name: stock.stocks.name,
	}));
}

export async function recordNotification(
	supabase: AppSupabaseClient,
	entry: NotificationLogEntry,
): Promise<boolean> {
	const { error } = await supabase.from("notification_log").insert({
		user_id: entry.userId,
		type: entry.type,
		delivery_method: entry.deliveryMethod,
		message_delivered: entry.messageDelivered,
		message: entry.message,
		error: entry.error,
		error_code: entry.errorCode,
	});

	if (error) {
		console.error("Failed to record notification:", error);
		return false;
	}

	return true;
}
