import { DateTime } from "luxon";
import type { Database } from "../db/generated/database.types";
import type {
	AppSupabaseClient,
	createSupabaseAdminClient,
} from "../db/supabase";
import type { Logger } from "../logging";
import { recordNotification } from "../messaging/shared";
import type { UserStockRow } from "../messaging/types";
import { toIsoOrThrow } from "../time/format";

export const MAX_NOTIFICATION_RETRIES = 3;
export const USER_PROCESS_BATCH_SIZE = 5;

export type DeliveryMethod = Database["public"]["Enums"]["delivery_method"];
export type ScheduledNotificationType =
	Database["public"]["Enums"]["scheduled_notification_type"];
export type ScheduledNotificationStatus =
	Database["public"]["Enums"]["scheduled_notification_status"];

export type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface ScheduledNotificationTotals {
	skipped: number;
	logFailures: number;
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
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

export async function updateScheduledNotificationRow(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	scheduledMinutes: number;
	channel: DeliveryMethod;
	status: Extract<ScheduledNotificationStatus, "sent" | "failed">;
	error?: string;
	logger: Logger;
}) {
	const update: Database["public"]["Tables"]["scheduled_notifications"]["Update"] =
		options.status === "sent"
			? {
					status: "sent",
					sent_at: toIsoOrThrow(
						DateTime.utc(),
						"Failed to format UTC ISO string",
					),
					error: null,
				}
			: { status: "failed", error: options.error ?? "Unknown error" };

	const { error } = await options.supabase
		.from("scheduled_notifications")
		.update(update)
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel);

	if (error) {
		options.logger.error(
			"Failed to update scheduled_notifications row",
			{ userId: options.userId, channel: options.channel },
			error,
		);
	}
}

export async function logRetriesExhausted(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	scheduledMinutes: number;
	channel: DeliveryMethod;
	logger: Logger;
}) {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("attempt_count,status")
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel)
		.maybeSingle();

	if (error) {
		options.logger.error(
			"Failed to fetch scheduled_notifications row",
			{ userId: options.userId, channel: options.channel },
			error,
		);
		return;
	}

	if (!data || data.status === "sent") {
		return;
	}

	if (data.attempt_count >= MAX_NOTIFICATION_RETRIES) {
		options.logger.warn("Retries exhausted; will retry next local day", {
			userId: options.userId,
			channel: options.channel,
		});

		await recordNotification(options.supabase, {
			user_id: options.userId,
			type: "scheduled_update",
			delivery_method: options.channel,
			message_delivered: false,
			message: "Retries exhausted; will retry next local day",
			error: `scheduled_notifications attempt_count >= ${MAX_NOTIFICATION_RETRIES}`,
		});
	}
}
