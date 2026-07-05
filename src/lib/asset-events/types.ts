export type AssetEventProvider = "earnings" | "dividends" | "splits" | "ipos";

/**
 * Telegram facet selection for asset events, sourced from notification_preferences.
 * When present, the content builder renders a `telegram` AssetEventsContent using the
 * rich email-style section formatting, gated by these facets. Additive: email
 * rendering is unchanged.
 */
export type AssetEventsTelegramFacets = {
	calendar: boolean;
	ipo: boolean;
	insider: boolean;
	analyst: boolean;
};

export type AssetEventsContent = {
	eventsSection: {
		earnings: string | null;
		dividends: string | null;
		splits: string | null;
		ipos: string | null;
	} | null;
	insiderSection: string | null;
	analystSection: string | null;
	hasAnyContent: boolean;
};

/** Result wrapper for market-wide calendar fetches (earnings, dividends, etc.). */
export interface ProviderResult<T> {
	data: T[];
	failed: boolean;
}

export interface EarningsEvent {
	ticker: string;
	date: string;
	time: string | null;
	epsEstimate: number | null;
	revenueEstimate: number | null;
}

export interface DividendEvent {
	ticker: string;
	exDividendDate: string;
	cashAmount: number;
	currency: string;
	payDate: string | null;
	frequency: number | null;
}

export interface SplitEvent {
	ticker: string;
	executionDate: string;
	splitFrom: number;
	splitTo: number;
	adjustmentType: string;
}

export interface IpoEvent {
	ticker: string;
	listingDate: string;
	issuerName: string | null;
	securityType: string | null;
}
