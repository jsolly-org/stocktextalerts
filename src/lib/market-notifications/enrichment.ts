import {
	type CompanyNewsItem,
	fetchCompanyNews,
} from "../providers/company-news";
import type { ExtendedAssetQuote } from "../providers/price-fetcher";
import type { AnomalyResult } from "./anomaly-detection";
import { generatePriceAlertSummary } from "./grok-summary";

export interface EnrichedAlert {
	symbol: string;
	priceContext: string;
	signalContext: string;
	headlines: CompanyNewsItem[];
	aiSummary: string | null;
}

/**
 * Fetch breaking news for a symbol (top 3 headlines from last 24h).
 */
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

/**
 * Build a human-readable price context string.
 */
function buildPriceContext(symbol: string, quote: ExtendedAssetQuote): string {
	const direction = quote.changePercent >= 0 ? "up" : "down";
	const absChange = Math.abs(quote.changePercent).toFixed(1);
	return `${symbol} is ${direction} ${absChange}% today ($${quote.price.toFixed(2)})`;
}

/**
 * Build a signal context string from triggered signals.
 */
function buildSignalContext(anomalyResult: AnomalyResult): string {
	const triggered = anomalyResult.signals.filter((s) => s.triggered);
	if (triggered.length === 0) return "unusual activity detected";
	return triggered.map((s) => s.detail).join(", ");
}

/**
 * Enrich a triggered alert with context for delivery.
 *
 * Fetches news, builds price/signal context, and optionally generates an AI summary.
 */
export async function enrichAlert(options: {
	symbol: string;
	quote: ExtendedAssetQuote;
	anomalyResult: AnomalyResult;
	news: CompanyNewsItem[];
}): Promise<EnrichedAlert> {
	const { symbol, quote, anomalyResult, news } = options;

	const priceContext = buildPriceContext(symbol, quote);
	const signalContext = buildSignalContext(anomalyResult);

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
