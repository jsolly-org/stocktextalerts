import {
	type CompanyNewsItem,
	fetchCompanyNews,
} from "../providers/company-news";
import type { ExtendedAssetQuote } from "../providers/price-fetcher";
import { generatePriceAlertSummary } from "./grok-summary";

/** Alert enriched with news headlines, optional AI summary, and intraday closing prices for sparkline rendering. */
export interface EnrichedAlert {
	symbol: string;
	priceContext: string;
	signalContext: string;
	headlines: CompanyNewsItem[];
	aiSummary: string | null;
	intradayCloses: number[] | null;
	/** First bar timestamp (ms) for sparkline axis; null when bars lack timestamps. */
	intradayStartTimestamp: number | null;
	/** Last bar timestamp (ms) for sparkline axis; null when bars lack timestamps. */
	intradayEndTimestamp: number | null;
	/** True when price moved up (changePercent >= 0). Used for subject-line direction. */
	isPositiveMove: boolean;
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

/** Enrich a triggered alert with news context, optional AI summary, and intraday closes for sparklines. */
export async function enrichAlert(options: {
	symbol: string;
	quote: ExtendedAssetQuote;
	signalContext: string;
	news: CompanyNewsItem[];
	intradayCloses: number[] | null;
	intradayStartTimestamp: number | null;
	intradayEndTimestamp: number | null;
}): Promise<EnrichedAlert> {
	const {
		symbol,
		quote,
		signalContext,
		news,
		intradayCloses,
		intradayStartTimestamp,
		intradayEndTimestamp,
	} = options;

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
		intradayCloses,
		intradayStartTimestamp,
		intradayEndTimestamp,
		isPositiveMove: quote.changePercent >= 0,
	};
}
