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
