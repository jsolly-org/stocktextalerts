/** Section id fragments used for dashboard navigation and deep links. */
export const DASHBOARD_SECTION_IDS = {
	notificationChannels: "notification-channels",
	assets: "watchlist",
	marketNotifications: "market-notifications",
	assetEvents: "asset-events-notifications",
	dailyNotifications: "daily-notifications",
	priceTargets: "price-targets",
} as const;

type DashboardSection = keyof typeof DASHBOARD_SECTION_IDS;

/** Hash links (e.g. `#watchlist`) for each dashboard section. */
export const DASHBOARD_SECTION_HASHES: Record<DashboardSection, string> = {
	notificationChannels: `#${DASHBOARD_SECTION_IDS.notificationChannels}`,
	assets: `#${DASHBOARD_SECTION_IDS.assets}`,
	marketNotifications: `#${DASHBOARD_SECTION_IDS.marketNotifications}`,
	assetEvents: `#${DASHBOARD_SECTION_IDS.assetEvents}`,
	dailyNotifications: `#${DASHBOARD_SECTION_IDS.dailyNotifications}`,
	priceTargets: `#${DASHBOARD_SECTION_IDS.priceTargets}`,
};
