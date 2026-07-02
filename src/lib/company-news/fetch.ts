import { type CompanyNewsItem, isRecord } from "../types";
import { marketDataFetch } from "../vendors/massive";
import {
	isOptionalVendorUnavailable,
	noteOptionalVendorSkip,
	recordOptionalVendorFailure,
	recordOptionalVendorSuccess,
} from "../vendors/optional-vendors";
import { COMPANY_NEWS_REQUEST_TIMEOUT_MS } from "./constants";

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
	if (isOptionalVendorUnavailable("company-news")) {
		noteOptionalVendorSkip();
		return [];
	}

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
		{ symbol },
		{
			maxRetries: 1,
			requestTimeoutMs: COMPANY_NEWS_REQUEST_TIMEOUT_MS,
			optional: true,
		},
	);
	if (!isRecord(data)) {
		recordOptionalVendorFailure("company-news");
		return [];
	}

	recordOptionalVendorSuccess("company-news");

	const results = data.results;
	if (!Array.isArray(results)) return [];

	return results
		.flatMap((item: unknown): CompanyNewsItem[] => {
			if (!isRecord(item)) return [];
			const row = item;

			if (typeof row.title !== "string") return [];
			if (typeof row.published_utc !== "string") return [];

			const parsed = Date.parse(row.published_utc);
			if (Number.isNaN(parsed)) return [];

			const tickers = Array.isArray(row.tickers)
				? (row.tickers as unknown[]).filter((t): t is string => typeof t === "string")
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
						isRecord(row.publisher) && typeof row.publisher.name === "string"
							? row.publisher.name
							: "",
					tickers,
				},
			];
		})
		.slice(0, 10);
}
