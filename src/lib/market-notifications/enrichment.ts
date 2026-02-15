import {
	type CompanyNewsItem,
	fetchCompanyNews,
} from "../providers/company-news";
import type { ExtendedAssetQuote } from "../providers/price-fetcher";
import { generatePriceAlertSummary } from "./grok-summary";

export interface EnrichedAlert {
	symbol: string;
	priceContext: string;
	signalContext: string;
	headlines: CompanyNewsItem[];
	aiSummary: string | null;
}

/** Fetch breaking news for a symbol (top 3 headlines from the last 24h). */
export async function fetchBreakingNews(
	symbol: string,
): Promise<CompanyNewsItem[]> {
	const now = new Date();
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	const news = await fetchCompanyNews(symbol, from, to);
	return news.slice(0, 3);
}

/** Build a human-readable price context string. */
function buildPriceContext(symbol: string, quote: ExtendedAssetQuote): string {
	const direction = quote.changePercent >= 0 ? "up" : "down";
	const absChange = Math.abs(quote.changePercent).toFixed(1);
	return `${symbol} is ${direction} ${absChange}% today ($${quote.price.toFixed(2)})`;
}

/** Enrich a triggered alert with news context and optional AI summary. */
export async function enrichAlert(options: {
	symbol: string;
	quote: ExtendedAssetQuote;
	signalContext: string;
	news: CompanyNewsItem[];
}): Promise<EnrichedAlert> {
	const { symbol, quote, signalContext, news } = options;

	const priceContext = buildPriceContext(symbol, quote);

	// Only attempt AI summary if there are news headlines
	let aiSummary: string | null = null;
	if (news.length > 0) {
		aiSummary = await generatePriceAlertSummary({
			symbol,
			priceContext,
			signalContext,
			headlines: news.map((n) => n.headline),
		});
	}

	return {
		symbol,
		priceContext,
		signalContext,
		headlines: news,
		aiSummary,
	};
}
