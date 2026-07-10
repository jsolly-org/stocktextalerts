import { type CompanyNewsItem, isRecord } from "../types";
import { marketDataFetch } from "../vendors/massive";
import { isOptionalVendorUnavailable, noteOptionalVendorSkip } from "../vendors/optional-vendors";
import { COMPANY_NEWS_MAX_ARTICLES, COMPANY_NEWS_REQUEST_TIMEOUT_MS } from "./constants";

/**
 * Maximum number of ticker tags an article may carry before it is treated as a
 * generic roundup (for example, "10 stocks to buy now") rather than company news.
 */
const MAX_TICKERS_PER_ARTICLE = 5;

/** Fetch recent company news headlines for a ticker from Massive. */
export async function fetchCompanyNews(
	symbol: string,
	from: string,
	to: string,
): Promise<CompanyNewsItem[]> {
	if (isOptionalVendorUnavailable("company-news")) {
		noteOptionalVendorSkip();
		return [];
	}

	// Massive datetime filters treat a bare YYYY-MM-DD as midnight UTC — use full
	// day bounds so `to = today` still includes today's articles.
	const data = await marketDataFetch(
		"/v2/reference/news",
		{
			ticker: symbol,
			"published_utc.gte": `${from}T00:00:00Z`,
			"published_utc.lte": `${to}T23:59:59Z`,
			limit: String(COMPANY_NEWS_MAX_ARTICLES),
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
	if (!isRecord(data) || !Array.isArray(data.results)) {
		// Throw so withOptionalVendorBudget records failure and can open the circuit.
		// A successful empty `results: []` is a normal "no articles" answer, not a failure.
		throw new Error(`Massive company-news returned unexpected payload for ${symbol}`);
	}

	return data.results
		.flatMap((item: unknown): CompanyNewsItem[] => {
			if (!isRecord(item)) return [];
			const row = item;

			if (typeof row.title !== "string" || row.title === "") return [];
			if (typeof row.published_utc !== "string") return [];
			const publishedAt = Date.parse(row.published_utc);
			if (Number.isNaN(publishedAt)) return [];

			const tickers = Array.isArray(row.tickers)
				? row.tickers.filter((ticker): ticker is string => typeof ticker === "string")
				: [];
			if (tickers.length > MAX_TICKERS_PER_ARTICLE) return [];

			return [
				{
					headline: row.title,
					summary: typeof row.description === "string" ? row.description : "",
					datetime: Math.floor(publishedAt / 1000),
					url: typeof row.article_url === "string" ? row.article_url : "",
					source:
						isRecord(row.publisher) && typeof row.publisher.name === "string"
							? row.publisher.name
							: "",
					tickers,
				},
			];
		})
		.slice(0, COMPANY_NEWS_MAX_ARTICLES);
}
