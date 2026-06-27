import { DateTime } from "luxon";
import type { Database } from "../db/generated/database.types";
import type { AppSupabaseClient, createSupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { recordNotification } from "../messaging/shared";
import type { UserAssetRow } from "../messaging/types";
import { toIsoOrThrow } from "../time/format";
import type { ScheduledSlotKey } from "../types";
import { computeDeliveryRetryDelayMs } from "../vendors/vendor-fault-tolerance";

export const MAX_NOTIFICATION_RETRIES = 3;
/** Number of users to process concurrently in scheduled-delivery jobs. */
export const USER_PROCESS_BATCH_SIZE = 5;

/** Delivery channel enum sourced from the database schema. */
export type DeliveryMethod = Database["public"]["Enums"]["delivery_method"];

/** Scheduled notification type enum sourced from the database schema. */
export type ScheduledNotificationType = Database["public"]["Enums"]["scheduled_notification_type"];

/** Row delivery status enum sourced from the database schema. */
export type ScheduledNotificationStatus =
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
	telegramSent: number;
	telegramFailed: number;
}

/**
 * Load a user's tracked assets (symbol + asset name) from the database.
 *
 * Throws on query errors; returns a normalized list on success.
 * Set includeLogoData when the caller will render email logos to avoid
 * unnecessary DB/network payload for SMS-only runs.
 */
export async function loadUserAssets(
	supabase: AppSupabaseClient,
	userId: string,
	options?: { includeLogoData?: boolean },
): Promise<UserAssetRow[]> {
	const includeLogoData = options?.includeLogoData === true;
	const assetSelect = includeLogoData
		? "symbol, assets!inner(name, icon_url, icon_base64)"
		: "symbol, assets!inner(name)";
	const { data: assets, error } = await supabase
		.from("user_assets")
		.select(assetSelect)
		.eq("user_id", userId);

	if (error) {
		throw error;
	}

	return assets.map((asset) => {
		const base = { symbol: asset.symbol, name: asset.assets.name };
		if (includeLogoData && "icon_url" in asset.assets) {
			return {
				...base,
				icon_url: (asset.assets as { icon_url: string | null }).icon_url,
				icon_base64: (asset.assets as { icon_base64: string | null }).icon_base64,
			};
		}
		return base;
	});
}

/** Map of user id to that user's tracked assets. */
export type UserAssetsMap = Map<string, UserAssetRow[]>;

/** Max IDs per in() filter to stay under PostgREST/URL length limits (414 URI Too Long). */
const IN_FILTER_CHUNK_SIZE = 50;

/**
 * Batch-load tracked assets for multiple users in a single query.
 *
 * Returns a Map keyed by user_id. Use this to avoid N+1 queries when processing
 * multiple users in a scheduled run.
 *
 * Chunks the user_id list to avoid PostgREST in() URL length limits (414 URI Too Long).
 * Set includeLogoData when the run may send email with logos to avoid unnecessary
 * DB/network payload for SMS-only runs.
 */
export async function batchLoadUserAssets(
	supabase: AppSupabaseClient,
	userIds: string[],
	options?: { includeLogoData?: boolean },
): Promise<UserAssetsMap> {
	if (userIds.length === 0) {
		return new Map();
	}

	const includeLogoData = options?.includeLogoData === true;
	// Include assets.delisted_at so we can filter out delisted holdings at
	// the loader level (defense in depth). The sweep sets assets.delisted_at
	// and deletes the user_assets row in the same Lambda run, but if the
	// email send fails the sweep intentionally skips cleanup so it can retry
	// next day — leaving an assets row flagged delisted while user_assets
	// still references it. This filter keeps the price fetcher from ever
	// seeing such a row, regardless of sweep state.
	const assetSelect = includeLogoData
		? "user_id, symbol, assets!inner(name, icon_url, icon_base64, delisted_at)"
		: "user_id, symbol, assets!inner(name, delisted_at)";

	const uniqueIds = [...new Set(userIds)];
	const map = new Map<string, UserAssetRow[]>();
	for (const id of uniqueIds) {
		map.set(id, []);
	}

	for (let chunkStart = 0; chunkStart < uniqueIds.length; chunkStart += IN_FILTER_CHUNK_SIZE) {
		const chunk = uniqueIds.slice(chunkStart, chunkStart + IN_FILTER_CHUNK_SIZE);
		const pageSize = 1000;
		for (let from = 0; ; from += pageSize) {
			const { data: rows, error } = await supabase
				.from("user_assets")
				.select(assetSelect)
				.in("user_id", chunk)
				.is("assets.delisted_at", null)
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
					assets: {
						name: string;
						delisted_at: string | null;
					} & ({ icon_url: string | null; icon_base64: string | null } | Record<string, never>);
				};
				// Belt-and-suspenders: the PostgREST .is() filter above should
				// already exclude delisted rows, but double-check in case the
				// query ever gets refactored.
				if (typed.assets.delisted_at !== null) continue;
				const entry = map.get(typed.user_id) ?? [];
				const base = { symbol: typed.symbol, name: typed.assets.name };
				if (includeLogoData && "icon_url" in typed.assets) {
					entry.push({
						...base,
						icon_url: typed.assets.icon_url,
						icon_base64: typed.assets.icon_base64,
					});
				} else {
					entry.push(base);
				}
				map.set(typed.user_id, entry);
			}

			if ((rows ?? []).length < pageSize) {
				break;
			}
		}
	}
	return map;
}

/** Read attempt_count for a scheduled notification row (0 when missing). */
async function getScheduledNotificationAttemptCount(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
	} & ScheduledSlotKey,
): Promise<number> {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("attempt_count")
		.eq("user_id", options.userId)
		.eq("notification_type", options.notificationType)
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes)
		.eq("channel", options.channel)
		.maybeSingle();

	if (error || !data) return 0;
	return data.attempt_count;
}

/** Max attempt_count across channels for a daily digest slot. */
export async function getMaxDailyDigestSlotAttempts(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
	} & ScheduledSlotKey,
): Promise<number> {
	const { data, error } = await options.supabase
		.from("scheduled_notifications")
		.select("attempt_count")
		.eq("user_id", options.userId)
		.eq("notification_type", "daily")
		.eq("scheduled_date", options.scheduledDate)
		.eq("scheduled_minutes", options.scheduledMinutes);

	if (error || !data || data.length === 0) return 0;
	return data.reduce((max, row) => Math.max(max, row.attempt_count), 0);
}

/**
 * Update the status/error fields for a specific scheduled notification row.
 *
 * This is keyed by the composite uniqueness of:
 * user + notification type + scheduled date/minutes + channel.
 */
export async function updateScheduledNotificationRow(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		status: Extract<ScheduledNotificationStatus, "sent" | "failed">;
		error?: string;
		/** Post-claim attempt_count from claimNotification — when provided, skips the re-SELECT
		 *  the failed branch would otherwise do to compute the backoff. */
		attemptCount?: number;
		logger: Logger;
	} & ScheduledSlotKey,
) {
	type UpdateChain = {
		eq: (column: string, value: unknown) => UpdateChain;
	};

	const nowIso = toIsoOrThrow(DateTime.utc(), "Failed to format UTC ISO string");
	let update: Database["public"]["Tables"]["scheduled_notifications"]["Update"];
	if (options.status === "sent") {
		update = {
			status: "sent",
			sent_at: nowIso,
			error: null,
			next_retry_at: null,
		};
	} else {
		const attemptCount =
			options.attemptCount ?? (await getScheduledNotificationAttemptCount(options));
		const retryAt = DateTime.fromISO(nowIso, { zone: "utc" }).plus({
			milliseconds: computeDeliveryRetryDelayMs(attemptCount),
		});
		const retryAtIso = retryAt.isValid ? retryAt.toISO() : null;
		update = {
			status: "failed",
			error: options.error ?? "Unknown error",
			next_retry_at: retryAtIso,
		};
	}

	const scheduledNotifications = options.supabase.from("scheduled_notifications") as unknown as {
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
	/** Claimed; `attemptCount` is the post-claim count the RPC just set (>= 1), threaded to
	 *  `updateScheduledNotificationRow` so the failure path needn't re-read it. */
	| { status: "claimed"; attemptCount: number }
	| { status: "claim_error" }
	| { status: "retries_exhausted" }
	| { status: "not_ready" };

/**
 * Claim a scheduled notification via the `claim_scheduled_notification` RPC.
 *
 * Encapsulates the RPC call, error logging, and retries-exhaustion recording so
 * delivery functions can replace ~25 lines of boilerplate with a single call.
 */
export async function claimNotification(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		logger: Logger;
	} & ScheduledSlotKey,
): Promise<ClaimResult> {
	const { supabase, userId, notificationType, scheduledDate, scheduledMinutes, channel, logger } =
		options;

	const { data: claimedRaw, error: claimError } = await (
		supabase as unknown as {
			rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
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

	// The RPC returns the post-claim attempt_count (>= 1) when this run won the claim, or NULL
	// when denied (already sent / retries exhausted / not yet due per the backoff).
	const claimedAttemptCount = typeof claimedRaw === "number" ? claimedRaw : null;
	if (claimedAttemptCount === null) {
		const { data: row, error: rowError } = await supabase
			.from("scheduled_notifications")
			.select("attempt_count, status")
			.eq("user_id", userId)
			.eq("notification_type", notificationType)
			.eq("scheduled_date", scheduledDate)
			.eq("scheduled_minutes", scheduledMinutes)
			.eq("channel", channel)
			.maybeSingle();

		if (rowError) {
			logger.error(
				`Failed to read ${notificationType} notification row after claim denied (${channel})`,
				{ userId },
				rowError,
			);
			return { status: "claim_error" };
		}

		if (row && row.attempt_count >= MAX_NOTIFICATION_RETRIES) {
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

		return { status: "not_ready" };
	}

	return { status: "claimed", attemptCount: claimedAttemptCount };
}

/**
 * Record that retries were exhausted for a scheduled notification, and write a log row.
 *
 * This is used as a backstop so we can track delivery failures without spamming retries
 * within a single run.
 */
async function logRetriesExhausted(
	options: {
		supabase: SupabaseAdminClient;
		userId: string;
		notificationType: ScheduledNotificationType;
		channel: DeliveryMethod;
		logger: Logger;
	} & ScheduledSlotKey,
) {
	type SelectChain = {
		eq: (column: string, value: unknown) => SelectChain;
		maybeSingle: () => unknown;
	};

	const scheduledNotifications = options.supabase.from("scheduled_notifications") as unknown as {
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
		// Terminal delivery failure for today (any cause: Twilio outage, DB
		// error, sustained rate limit). Next-day cron tick reattempts, but
		// the user missed today's notification — alarm should see this.
		options.logger.error(
			"Retries exhausted; will retry next local day",
			{ userId: options.userId, channel: options.channel },
			new Error(`scheduled_notifications attempt_count >= ${MAX_NOTIFICATION_RETRIES}`),
		);

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
