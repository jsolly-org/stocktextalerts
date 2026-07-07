import { type CompanyNewsItem, isRecord } from "../types";
import { finnhubFetch } from "../vendors/finnhub";
import {
	isOptionalVendorUnavailable,
	noteOptionalVendorSkip,
	recordOptionalVendorFailure,
	recordOptionalVendorSuccess,
} from "../vendors/optional-vendors";
import { COMPANY_NEWS_MAX_ARTICLES } from "./constants";

/**
 * Fetch recent company news headlines for a ticker within a date range from Finnhub
 * `/company-news` (free tier, one symbol per call, `from`/`to` as YYYY-MM-DD).
 * Finnhub returns newest-first, single-symbol articles — no roundup filtering needed.
 */
export async function fetchCompanyNews(
	symbol: string,
	from: string,
	to: string,
): Promise<CompanyNewsItem[]> {
	if (isOptionalVendorUnavailable("company-news")) {
		noteOptionalVendorSkip();
		return [];
	}

	const data = await finnhubFetch("/company-news", { symbol, from, to }, "company-news", {
		optional: true,
	});
	if (!Array.isArray(data)) {
		recordOptionalVendorFailure("company-news");
		return [];
	}

	recordOptionalVendorSuccess("company-news");

	return data
		.flatMap((item: unknown): CompanyNewsItem[] => {
			if (!isRecord(item)) return [];
			const row = item;

			if (typeof row.headline !== "string" || row.headline === "") return [];
			if (typeof row.datetime !== "number" || !Number.isFinite(row.datetime)) return [];

			return [
				{
					headline: row.headline,
					summary: typeof row.summary === "string" ? row.summary : "",
					datetime: Math.floor(row.datetime),
					url: typeof row.url === "string" ? row.url : "",
					source: typeof row.source === "string" ? row.source : "",
				},
			];
		})
		.slice(0, COMPANY_NEWS_MAX_ARTICLES);
}
