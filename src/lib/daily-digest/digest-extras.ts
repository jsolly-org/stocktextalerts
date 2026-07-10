/**
 * Daily-digest Massive company-news fetch for Grok context.
 *
 * Analyst/insider live in the asset-events path via `loadStoredFinnhubExtras`
 * (DB-backed, filled by the enrichment pipeline) — not fetched here.
 */
import { setTimeout as realDelay } from "node:timers/promises";
import { COMPANY_NEWS_USER_BUDGET_MS } from "../company-news/constants";
import { fetchCompanyNews } from "../company-news/fetch";
import type { CompanyNewsItem } from "../types";
import { isOptionalVendorUnavailable, withOptionalVendorBudget } from "../vendors/optional-vendors";

const INTER_REQUEST_DELAY_MS = 100;

/**
 * Fetch Massive company news for the given symbols (Grok email context).
 * Soft-fails under the per-user news budget; open company-news circuit skips the batch.
 */
export async function fetchDigestNewsForGrok(
	symbols: string[],
): Promise<Map<string, CompanyNewsItem[]>> {
	const news = new Map<string, CompanyNewsItem[]>();

	if (symbols.length === 0) return news;
	if (isOptionalVendorUnavailable("company-news")) return news;

	// Date range for Massive company news: last 3 days.
	const now = new Date();
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	let newsBudgetRemainingMs = COMPANY_NEWS_USER_BUDGET_MS;

	for (const symbol of symbols) {
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
			news.set(symbol, newsResult.value);
		} else {
			break;
		}
		await realDelay(INTER_REQUEST_DELAY_MS);
	}

	return news;
}

/** Flatten news Map into a compact string for the Grok prompt. */
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
