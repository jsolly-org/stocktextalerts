import { DateTime } from "luxon";
import type { Database } from "../db/generated/database.types";
import type {
	AppSupabaseClient,
	createSupabaseAdminClient,
} from "../db/supabase";
import type { Logger } from "../logging";
import { recordNotification } from "../messaging/shared";
import type { UserAssetRow } from "../messaging/types";
import { toIsoOrThrow } from "../time/format";

const MAX_NOTIFICATION_RETRIES = 3;
/** Number of users to process concurrently in scheduled-delivery jobs. */
export const USER_PROCESS_BATCH_SIZE = 5;

/** Delivery channel enum sourced from the database schema. */
export type DeliveryMethod = Database["public"]["Enums"]["delivery_method"];

type ScheduledNotificationType = "market" | "daily" | "asset_events";

type ScheduledNotificationStatus =
	Database["public"]["Enums"]["scheduled_notification_status"];

/** Supabase admin client type used by schedule jobs/RPCs. */
export type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Aggregate counters for a scheduler run (used for logging/metrics). */
export interface ScheduledNotificationTotals {
	skipped: number;
	logFailures: number;
	emailsSent: number;
	emailsFailed: number;
	smsSent: number;
	smsFailed: number;
}

/**
 * Load a user's tracked assets (symbol + asset name) from the database.
 *
 * Throws on query errors; returns a normalized list on success.
 */
export async function loadUserAssets(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<UserAssetRow[]> {
	const { data: assets, error } = await supabase
		.from("user_assets")
		.select("symbol, assets!inner(name)")
		.eq("user_id", userId);

	if (error) {
		throw error;
	}

	return assets.map((asset) => ({
		symbol: asset.symbol,
		name: asset.assets.name,
	}));
}

/** Map of user id to that user's tracked assets. */
export type UserAssetsMap = Map<string, UserAssetRow[]>;

/**
 * Batch-load tracked assets for multiple users in a single query.
 *
 * Returns a Map keyed by user_id. Use this to avoid N+1 queries when processing
 * multiple users in a scheduled run.
 */
export async function batchLoadUserAssets(
	supabase: AppSupabaseClient,
	userIds: string[],
): Promise<UserAssetsMap> {
	if (userIds.length === 0) {
		return new Map();
	}

	const uniqueIds = [...new Set(userIds)];
	const map = new Map<string, UserAssetRow[]>();
	for (const id of uniqueIds) {
		map.set(id, []);
	}

	const pageSize = 1000;
	for (let from = 0; ; from += pageSize) {
		const { data: rows, error } = await supabase
			.from("user_assets")
			.select("user_id, symbol, assets!inner(name)")
			.in("user_id", uniqueIds)
			.order("user_id", { ascending: true })
			.order("symbol", { ascending: true })
			.range(from, from + pageSize - 1);

		if (error) {
			throw error;
		}

		for (const row of rows ?? []) {
			const typed = row as {
				user_id: string;
				symbol: string;
				assets: { name: string };
			};
			const entry = map.get(typed.user_id) ?? [];
			entry.push({ symbol: typed.symbol, name: typed.assets.name });
			map.set(typed.user_id, entry);
		}

		if ((rows ?? []).length < pageSize) {
			break;
		}
	}
	return map;
}

/**
 * Update the status/error fields for a specific scheduled notification row.
 *
 * This is keyed by the composite uniqueness of:
 * user + notification type + scheduled date/minutes + channel.
 */
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
	type UpdateChain = {
		eq: (column: string, value: unknown) => UpdateChain;
	};

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

	const scheduledNotifications = options.supabase.from(
		"scheduled_notifications",
	) as unknown as {
		update: (
			payload: Database["public"]["Tables"]["scheduled_notifications"]["Update"],
		) => UpdateChain;
	};

	const { error } = await (scheduledNotifications
		.update(update)
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel) as unknown as Promise<{
		error: unknown | null;
	}>);

	if (error) {
		options.logger.error(
			"Failed to update scheduled_notifications row",
			{ userId: options.userId, channel: options.channel },
			error,
		);
	}
}

type ClaimResult =
	| { status: "claimed" }
	| { status: "claim_error" }
	| { status: "retries_exhausted" };

/**
 * Claim a scheduled notification via the `claim_scheduled_notification` RPC.
 *
 * Encapsulates the RPC call, error logging, and retries-exhaustion recording so
 * delivery functions can replace ~25 lines of boilerplate with a single call.
 */
export async function claimNotification(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	scheduledMinutes: number;
	channel: DeliveryMethod;
	logger: Logger;
}): Promise<ClaimResult> {
	const {
		supabase,
		userId,
		notificationType,
		scheduledDate,
		scheduledMinutes,
		channel,
		logger,
	} = options;

	const { data: claimed, error: claimError } = await (
		supabase as unknown as {
			rpc: (
				fn: string,
				args: unknown,
			) => Promise<{ data: unknown; error: unknown }>;
		}
	).rpc("claim_scheduled_notification", {
		p_user_id: userId,
		p_notification_type: notificationType,
		p_scheduled_date: scheduledDate,
		p_scheduled_minutes: scheduledMinutes,
		p_channel: channel,
	});

	if (claimError) {
		logger.error(
			`Failed to claim ${notificationType} notification (${channel})`,
			{ userId },
			claimError,
		);
		return { status: "claim_error" };
	}

	if (!claimed) {
		await logRetriesExhausted({
			supabase,
			userId,
			notificationType,
			scheduledDate,
			scheduledMinutes,
			channel,
			logger,
		});
		return { status: "retries_exhausted" };
	}

	return { status: "claimed" };
}

/**
 * Record that retries were exhausted for a scheduled notification, and write a log row.
 *
 * This is used as a backstop so we can track delivery failures without spamming retries
 * within a single run.
 */
async function logRetriesExhausted(options: {
	supabase: SupabaseAdminClient;
	userId: string;
	notificationType: ScheduledNotificationType;
	scheduledDate: string;
	scheduledMinutes: number;
	channel: DeliveryMethod;
	logger: Logger;
}) {
	type SelectChain = {
		eq: (column: string, value: unknown) => SelectChain;
		maybeSingle: () => unknown;
	};

	const scheduledNotifications = options.supabase.from(
		"scheduled_notifications",
	) as unknown as {
		select: (columns: string) => SelectChain;
	};

	const { data, error } = await (scheduledNotifications
		.select("attempt_count,status")
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel)
		.maybeSingle() as unknown as Promise<{
		data: {
			attempt_count: number;
			status: ScheduledNotificationStatus;
		} | null;
		error: unknown | null;
	}>);

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
			type: options.notificationType,
			delivery_method: options.channel,
			message_delivered: false,
			message: "Retries exhausted; will retry next local day",
			error: `scheduled_notifications attempt_count >= ${MAX_NOTIFICATION_RETRIES}`,
		});
	}
}
