import type { Database } from "../db/generated/database.types";

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
