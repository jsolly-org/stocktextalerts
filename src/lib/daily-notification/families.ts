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
