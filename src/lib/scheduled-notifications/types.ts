import type { Database } from "../db/generated/database.types";
import type { ChannelDeliveryStats } from "../types";

/** Delivery channel enum sourced from the database schema. */
export type DeliveryMethod = Database["public"]["Enums"]["delivery_method"];

/** Scheduled notification type enum sourced from the database schema. */
export type ScheduledNotificationType = Database["public"]["Enums"]["scheduled_notification_type"];

/** Row delivery status enum sourced from the database schema. */
export type ScheduledNotificationStatus =
	Database["public"]["Enums"]["scheduled_notification_status"];

/** Aggregate counters for a scheduler run (used for logging/metrics). */
export interface ScheduledNotificationTotals extends ChannelDeliveryStats {
	skipped: number;
}
