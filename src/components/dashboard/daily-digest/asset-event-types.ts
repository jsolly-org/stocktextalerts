export const ASSET_EVENT_TYPES = [
	{
		key: "calendar" as const,
		label: "Calendar Events",
		description:
			"Included in your daily delivery when earnings, ex-dividend dates, or stock splits are scheduled in the next 3 days.",
		massive: true,
		finnhub: true,
		plainIcon: null,
	},
	{
		key: "ipo" as const,
		label: "Upcoming IPOs",
		description:
			"Included in your daily delivery when an IPO listing date is within the next 3 days.",
		massive: true,
		finnhub: false,
		plainIcon: null,
	},
	{
		key: "analyst" as const,
		label: "Analyst Consensus",
		description: "Sent at most once per month, usually in your first delivery of the month.",
		massive: false,
		finnhub: true,
		plainIcon: null,
	},
	{
		key: "insider" as const,
		label: "Insider Trades",
		description: "Can appear in your daily delivery when new insider filings are available.",
		massive: false,
		finnhub: true,
		plainIcon: null,
	},
	{
		key: "filings" as const,
		label: "SEC Filings",
		description: "Material 8-K and 6-K filings for your watchlist, with links to EDGAR.",
		massive: false,
		finnhub: false,
		plainIcon: "newspaper" as const,
	},
	{
		key: "short_interest" as const,
		label: "Short Interest",
		description:
			"Included in your daily delivery when a FINRA short-interest report is scheduled in the next 3 days.",
		massive: false,
		finnhub: false,
		plainIcon: "chart-bar" as const,
	},
] as const;

export type AssetEventKey = (typeof ASSET_EVENT_TYPES)[number]["key"];

/** IPO stays available without a watchlist; every other asset-event needs tracked assets. */
export function isAssetEventBlocked(key: AssetEventKey, hasTrackedAssets: boolean): boolean {
	return !hasTrackedAssets && key !== "ipo";
}

export function selectableAssetEventKeys(hasTrackedAssets: boolean): AssetEventKey[] {
	return ASSET_EVENT_TYPES.filter((t) => !isAssetEventBlocked(t.key, hasTrackedAssets)).map(
		(t) => t.key,
	);
}
