/* =============
Notification family boundaries (domain taxonomy).

1. Trigger-based — event-driven (anomaly, price move).
2. Scheduled slot — user-chosen times (market scheduled price updates).
3. Daily notification — one slot per day; digest + asset-event facets share it.
============= */

import type { AssetEventsContent, DailyDigestContent, NotificationPreferenceType } from "../types";

/** Canonical preference type for the unified daily notification. */
export const DAILY_NOTIFICATION_PREFERENCE_TYPE =
	"daily_notification" as const satisfies NotificationPreferenceType;

/** Digest-family facets of the daily notification slot. */
export const DAILY_DIGEST_FACETS = [
	"prices",
	"top_movers",
	"news",
	"rumors",
] as const satisfies readonly DailyDigestContent[];

/** Asset-event-family facets of the daily notification slot. */
export const DAILY_ASSET_EVENT_FACETS = [
	"calendar",
	"ipo",
	"analyst",
	"insider",
] as const satisfies readonly AssetEventsContent[];

/** Default local delivery minute when daily notification is enabled but no time is set. */
export const DEFAULT_DAILY_NOTIFICATION_DELIVERY_MINUTES = 540; // 9:00 AM
