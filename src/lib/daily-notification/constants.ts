/* =============
Notification family boundaries (domain taxonomy).

1. Trigger-based — event-driven (anomaly, price move, price target).
2. Scheduled slot — user-chosen times (market scheduled price updates).
3. Daily notification — one slot per day; digest + asset-event facets share it.
============= */

import type { NotificationPreferenceType } from "../types";

/** Canonical preference type for the unified daily notification. */
export const DAILY_NOTIFICATION_PREFERENCE_TYPE =
	"daily_notification" as const satisfies NotificationPreferenceType;

/** Default local delivery minute when daily notification is enabled but no time is set. */
export const DEFAULT_DAILY_NOTIFICATION_DELIVERY_MINUTES = 540; // 9:00 AM
