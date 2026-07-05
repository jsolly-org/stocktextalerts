import { DASHBOARD_SECTION_IDS } from "../../lib/constants";

/* =============
Dashboard Form IDs
============= */

/** DOM id for the notification preferences form. */
export const DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID = "dashboard-notification-preferences-form";
/** DOM id for the "save status" element for notification preferences. */
export const DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID =
	"dashboard-notification-preferences-save-status";
/** DOM id for the tracked-assets (watchlist) form. */
export const DASHBOARD_ASSETS_FORM_ID = "dashboard-assets-form";
/** DOM id for the "save status" element for tracked-assets (watchlist). */
export const DASHBOARD_ASSETS_STATUS_ID = "dashboard-assets-save-status";
/** DOM id for the market notifications form. */
export const DASHBOARD_MARKET_FORM_ID = "dashboard-market-form";
/** DOM id for the daily notifications form. */
export const DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID = "dashboard-daily-notifications-form";

/* =============
Dashboard carousel / URL persistence
============= */

/** Map hash fragment (without #) → carousel tab index. */
export const DASHBOARD_HASH_TO_TAB_INDEX: Record<string, number> = {
	[DASHBOARD_SECTION_IDS.assets]: 0,
	[DASHBOARD_SECTION_IDS.notificationChannels]: 1,
	[DASHBOARD_SECTION_IDS.dailyNotifications]: 2,
	[DASHBOARD_SECTION_IDS.marketNotifications]: 3,
	// Legacy hash — asset events now live in the daily notification panel.
	[DASHBOARD_SECTION_IDS.assetEvents]: 2,
	daily_digest_time: 1,
};

/** Reverse map: tab index → canonical hash for URL persistence. */
export const DASHBOARD_TAB_INDEX_TO_HASH: string[] = [
	DASHBOARD_SECTION_IDS.assets,
	DASHBOARD_SECTION_IDS.notificationChannels,
	DASHBOARD_SECTION_IDS.dailyNotifications,
	DASHBOARD_SECTION_IDS.marketNotifications,
];
