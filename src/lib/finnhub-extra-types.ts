export interface RecommendationTrend {
	buy: number;
	hold: number;
	sell: number;
	strongBuy: number;
	strongSell: number;
	period: string;
}

export interface InsiderTransaction {
	name: string;
	share: number;
	change: number;
	transactionType: string;
	transactionDate: string;
}

/** Minimal company-news item fields used in digests/sections. */
export interface CompanyNewsItem {
	headline: string;
	summary: string;
	datetime: number;
	url: string;
	source: string;
	/** Ticker symbols associated with this article (from API). */
	tickers: string[];
}
