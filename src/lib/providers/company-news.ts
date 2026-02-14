import { marketDataFetch } from "./massive";

/** Minimal company-news item fields used in digests/sections. */
export interface CompanyNewsItem {
	headline: string;
	summary: string;
	datetime: number;
	url: string;
	source: string;
}

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
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).title === "string" &&
				typeof (item as Record<string, unknown>).published_utc === "string",
		)
		.slice(0, 10)
		.map((item: Record<string, unknown>) => ({
			headline: item.title as string,
			summary:
				typeof item.description === "string"
					? (item.description as string)
					: "",
			datetime: Math.floor(Date.parse(item.published_utc as string) / 1000),
			url:
				typeof item.article_url === "string"
					? (item.article_url as string)
					: "",
			source:
				typeof item.publisher === "object" &&
				item.publisher !== null &&
				typeof (item.publisher as Record<string, unknown>).name === "string"
					? ((item.publisher as Record<string, unknown>).name as string)
					: "",
		}));
}
