/* =============
Notification family boundaries (domain taxonomy).

1. Trigger-based — event-driven (price move).
2. Scheduled slot — user-chosen times (market scheduled price updates).
3. Daily notification — one slot per day; digest + asset-event facets share it.
============= */

import type {
	AssetEventsContent,
	DailyNotificationContent,
	NotificationFamily,
	NotificationPreferenceType,
} from "../constants";
import { NOTIFICATION_OPTION_MATRIX } from "../constants";

/** Canonical preference type for the unified daily notification. */
export const DAILY_NOTIFICATION_PREFERENCE_TYPE =
	"daily_notification" as const satisfies NotificationPreferenceType;

const DAILY_FACETS = Object.entries(NOTIFICATION_OPTION_MATRIX.daily_notification) as Array<
	[DailyNotificationContent, { family: NotificationFamily }]
>;

/** Asset-event-family facets of the daily notification slot (derived from the matrix). */
export const DAILY_ASSET_EVENT_FACETS = DAILY_FACETS.filter(
	([, option]) => option.family === "asset_events",
).map(([content]) => content) as readonly AssetEventsContent[];

/** Default local delivery minute when daily notification is enabled but no time is set. */
export const DEFAULT_DAILY_NOTIFICATION_DELIVERY_MINUTES = 540; // 9:00 AM
