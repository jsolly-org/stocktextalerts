/**
 * Database helpers for the `staged_notifications` table.
 * Uses generated database types for typed access.
 */

import type { Json } from "../db/generated/database.types";
import type { SupabaseAdminClient } from "../schedule/helpers";
import type {
	StagedData,
	StagedNotificationRow,
	StagedNotificationType,
} from "./types";

/**
 * Insert a staged notification row (or ignore if already exists via unique constraint).
 */
export async function upsertStagedNotification(
	supabase: SupabaseAdminClient,
	options: {
		userId: string;
		notificationType: StagedNotificationType;
		scheduledFor: string;
		stagedData: StagedData;
	},
): Promise<{ error: unknown | null }> {
	const { userId, notificationType, scheduledFor, stagedData } = options;

	const { error } = await supabase.from("staged_notifications").upsert(
		{
			user_id: userId,
			notification_type: notificationType,
			scheduled_for: scheduledFor,
			staged_data: stagedData as unknown as Json,
		},
		{
			onConflict: "user_id,notification_type,scheduled_for",
			ignoreDuplicates: true,
		},
	);

	return { error };
}

/**
 * Fetch staged notifications that are due for delivery.
 */
export async function fetchDueStagedNotifications(
	supabase: SupabaseAdminClient,
	options: {
		cutoffTimeIso: string;
		notificationType: StagedNotificationType;
	},
): Promise<StagedNotificationRow[]> {
	const { cutoffTimeIso, notificationType } = options;

	const { data, error } = await supabase
		.from("staged_notifications")
		.select("id,user_id,notification_type,scheduled_for,staged_at,staged_data")
		.eq("notification_type", notificationType)
		.lte("scheduled_for", cutoffTimeIso);

	if (error) {
		throw error;
	}

	return (data ?? []) as unknown as StagedNotificationRow[];
}

/**
 * Delete a staged notification by primary key.
 */
export async function deleteStagedNotification(
	supabase: SupabaseAdminClient,
	id: string,
): Promise<void> {
	const { error } = await supabase
		.from("staged_notifications")
		.delete()
		.eq("id", id);
	if (error) throw error;
}

/** Purge staged notification rows older than the specified number of minutes. */
export async function purgeStaleStaged(
	supabase: SupabaseAdminClient,
	maxAgeMinutes: number,
): Promise<number> {
	const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

	const { data, error } = await supabase
		.from("staged_notifications")
		.delete()
		.lt("staged_at", cutoff)
		.select("id");

	if (error) {
		// Non-fatal: swallow and return 0 (log upstream if needed)
		return 0;
	}

	return data?.length ?? 0;
}
