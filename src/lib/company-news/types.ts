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
