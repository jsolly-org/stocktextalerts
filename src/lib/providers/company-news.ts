import { marketDataFetch } from "./massive";

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

/**
 * Maximum number of tickers an article can be tagged with before we consider
 * it a generic roundup piece (e.g. "5 Smart Stocks to Buy Right Now") and
 * filter it out for relevance.
 */
const MAX_TICKERS_PER_ARTICLE = 5;

/** Fetch recent company news headlines for a ticker within a date range. */
export async function fetchCompanyNews(
	symbol: string,
	from: string,
	to: string,
): Promise<CompanyNewsItem[]> {
	const data = await marketDataFetch(
		"/v2/reference/news",
		{
			ticker: symbol,
			"published_utc.gte": from,
			"published_utc.lte": to,
			limit: "10",
			sort: "published_utc",
			order: "desc",
		},
		"company-news",
	);
	if (typeof data !== "object" || data === null) return [];

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return [];

	return results
		.flatMap((item: unknown): CompanyNewsItem[] => {
			if (typeof item !== "object" || item === null) return [];
			const row = item as Record<string, unknown>;

			if (typeof row.title !== "string") return [];
			if (typeof row.published_utc !== "string") return [];

			const parsed = Date.parse(row.published_utc);
			if (Number.isNaN(parsed)) return [];

			const tickers = Array.isArray(row.tickers)
				? (row.tickers as unknown[]).filter(
						(t): t is string => typeof t === "string",
					)
				: [];

			// Skip generic roundup articles that tag many tickers
			if (tickers.length > MAX_TICKERS_PER_ARTICLE) return [];

			return [
				{
					headline: row.title,
					summary: typeof row.description === "string" ? row.description : "",
					datetime: Math.floor(parsed / 1000),
					url: typeof row.article_url === "string" ? row.article_url : "",
					source:
						typeof row.publisher === "object" &&
						row.publisher !== null &&
						typeof (row.publisher as Record<string, unknown>).name === "string"
							? ((row.publisher as Record<string, unknown>).name as string)
							: "",
					tickers,
				},
			];
		})
		.slice(0, 10);
}
