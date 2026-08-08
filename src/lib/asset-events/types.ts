export type AssetEventProvider = "earnings" | "dividends" | "splits" | "ipos";

/** One SEC filing line for digest rendering (label is the hyperlink text). */
export type SecFilingLine = {
	label: string;
	url: string;
};

/** One watchlist short-interest line for digest rendering. */
export type ShortInterestLine = {
	symbol: string;
	text: string;
};

/** Short-interest facet payload for a single digest delivery. */
export type ShortInterestDigestContent = {
	mode: "heads_up" | "report";
	publishDate: string;
	settlementDate: string;
	lines: ShortInterestLine[] | null;
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
	/** Material 8-K / 6-K lines; each label is rendered as the hyperlink. */
	filingsLines: SecFilingLine[] | null;
	/** FINRA short-interest heads-up or watchlist report for the calendar window. */
	shortInterest: ShortInterestDigestContent | null;
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
