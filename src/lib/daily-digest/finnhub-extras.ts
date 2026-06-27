import { setTimeout as realDelay } from "node:timers/promises";
import { fetchInsiderTransactions, fetchRecommendationTrends } from "../asset-events/enrichment";
import type { InsiderTransaction, RecommendationTrend } from "../asset-events/types";
import { fetchCompanyNews } from "../company-news/fetch";
import type { CompanyNewsItem } from "../company-news/types";
import {
	COMPANY_NEWS_USER_BUDGET_MS,
	isOptionalVendorUnavailable,
	withOptionalVendorBudget,
} from "../resilience/optional-vendors";

const INTER_REQUEST_DELAY_MS = 100;

/** Batch “extras” data fetched from Finnhub for a set of symbols. */
interface FinnhubExtrasData {
	news: Map<string, CompanyNewsItem[]>;
	analyst: Map<string, RecommendationTrend | null>;
	insider: Map<string, InsiderTransaction[]>;
	/** True when analyst was requested and at least one symbol got an HTTP response (not retry exhaustion). */
	analystFetchSucceeded: boolean;
}

/** Fetch enabled Finnhub “extras” (news/analyst/insider) for a set of symbols. */
export async function fetchFinnhubExtras(
	symbols: string[],
	options: {
		includeNews: boolean;
		includeAnalyst: boolean;
		includeInsider: boolean;
	},
): Promise<FinnhubExtrasData> {
	const result: FinnhubExtrasData = {
		news: new Map(),
		analyst: new Map(),
		insider: new Map(),
		analystFetchSucceeded: false,
	};

	if (symbols.length === 0) return result;
	if (!options.includeNews && !options.includeAnalyst && !options.includeInsider) return result;

	// Date range for company news: last 3 days
	const now = new Date();
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	let analystHttpFailures = 0;
	let newsBudgetRemainingMs = options.includeNews ? COMPANY_NEWS_USER_BUDGET_MS : 0;

	// Fetch sequentially per symbol with small delays to stay within rate limits
	for (const symbol of symbols) {
		const fetches: Promise<void>[] = [];

		if (options.includeNews) {
			if (newsBudgetRemainingMs <= 0 || isOptionalVendorUnavailable("company-news")) {
				break;
			}
			const budgetForSymbol = Math.min(newsBudgetRemainingMs, COMPANY_NEWS_USER_BUDGET_MS);
			const newsStart = Date.now();
			const newsResult = await withOptionalVendorBudget("company-news", budgetForSymbol, () =>
				fetchCompanyNews(symbol, from, to),
			);
			newsBudgetRemainingMs -= Date.now() - newsStart;
			if (newsResult.status === "ok") {
				result.news.set(symbol, newsResult.value);
			} else {
				break;
			}
		}

		if (options.includeAnalyst) {
			fetches.push(
				fetchRecommendationTrends(symbol).then(({ trend, httpSucceeded }) => {
					result.analyst.set(symbol, trend);
					if (!httpSucceeded) {
						analystHttpFailures++;
					}
				}),
			);
		}

		if (options.includeInsider) {
			fetches.push(
				fetchInsiderTransactions(symbol).then((data) => {
					result.insider.set(symbol, data);
				}),
			);
		}

		// Parallel fetches for the same symbol, sequential across symbols
		if (fetches.length > 0) {
			await Promise.all(fetches);
		}
		await realDelay(INTER_REQUEST_DELAY_MS);
	}

	if (options.includeAnalyst && symbols.length > 0) {
		result.analystFetchSucceeded = analystHttpFailures < symbols.length;
	}

	return result;
}

/** Build a compact, line-based news context string for Grok. */
export function buildNewsContextForGrok(newsData: Map<string, CompanyNewsItem[]>): string {
	const lines: string[] = [];
	for (const [symbol, items] of newsData) {
		if (items.length === 0) continue;
		for (const item of items) {
			const suffix = item.url ? ` — ${item.url}` : "";
			lines.push(`${symbol}: ${item.headline}${suffix}`);
		}
	}
	return lines.join("\n");
}
