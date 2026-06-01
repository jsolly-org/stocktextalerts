import { setTimeout as realDelay } from "node:timers/promises";
import { FINNHUB_BASE_URL } from "../constants";
import { requireEnv } from "../db/env";
import { rootLogger } from "../logging";
import { type CompanyNewsItem, fetchCompanyNews } from "./company-news";
import {
	COMPANY_NEWS_USER_BUDGET_MS,
	isOptionalVendorUnavailable,
	OPTIONAL_VENDOR_DEGRADED_CATEGORY,
	withOptionalVendorBudget,
} from "./vendor-fault-tolerance";
import {
	VENDOR_FETCH_MAX_RETRIES as MAX_RETRIES,
	VENDOR_FETCH_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
	VENDOR_FETCH_RETRY_DELAY_MS as RETRY_DELAY_MS,
} from "./vendor-fetch";

type DeliveryChannel = "sms" | "email";

/* =============
Types
============= */

export interface RecommendationTrend {
	buy: number;
	hold: number;
	sell: number;
	strongBuy: number;
	strongSell: number;
	period: string;
}

export interface InsiderTransaction {
	name: string;
	share: number;
	change: number;
	transactionType: string;
	transactionDate: string;
}

/** Batch “extras” data fetched from Finnhub for a set of symbols. */
interface FinnhubExtrasData {
	news: Map<string, CompanyNewsItem[]>;
	analyst: Map<string, RecommendationTrend | null>;
	insider: Map<string, InsiderTransaction[]>;
	/** True when analyst was requested and at least one symbol got an HTTP response (not retry exhaustion). */
	analystFetchSucceeded: boolean;
}

/* =============
Constants
============= */

const INTER_REQUEST_DELAY_MS = 100;

/* =============
Helpers
============= */

/** Read the Finnhub API key from env. Throws if not set. */
function getFinnhubApiKey(): string {
	return requireEnv("FINNHUB_API_KEY");
}

/** Parse `Retry-After` into a delay (ms), or `null` when missing/unparseable. */
function parseRetryAfterMs(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1_000;
	}
	const date = Date.parse(headerValue);
	if (Number.isFinite(date)) {
		const delayMs = date - Date.now();
		return delayMs > 0 ? delayMs : 0;
	}
	return null;
}

/** Redact the Finnhub `token=` query param from loggable strings. */
function redactFinnhubToken(value: string): string {
	return value.replace(/([?&]token=)[^&]+/gi, "$1[redacted]");
}

/** Compute retry delay with exponential backoff and jitter (respects Retry-After). */
function computeRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
	if (retryAfterMs !== null) {
		// Cap Retry-After at 60 s to avoid excessively long waits.
		return Math.min(retryAfterMs, 60_000);
	}
	const base = RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * base * 0.5;
	return base + jitter;
}

type FinnhubFailure =
	| { reason: "rate_limited"; status: 429 }
	| { reason: "api_error"; status: number }
	| { reason: "timeout"; error: Error }
	| { reason: "request_failed"; error: Error };

type FinnhubFetchPolicy = {
	/** When true, terminal failures log as optional degradation (warn), not vendor_retry_exhausted. */
	optional?: boolean;
};

/** Low-level Finnhub fetch wrapper with retries, timeouts, and rate-limit handling. */
export async function finnhubFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
	policy?: FinnhubFetchPolicy,
): Promise<unknown> {
	const optional = policy?.optional === true;
	const failureCategory = optional ? OPTIONAL_VENDOR_DEGRADED_CATEGORY : "vendor_retry_exhausted";
	const apiKey = getFinnhubApiKey();

	const query = new URLSearchParams({ ...params, token: apiKey });
	const url = `${FINNHUB_BASE_URL}${endpoint}?${query.toString()}`;

	// Per-attempt failures are silent. Only terminal exhaustion is logged:
	// rate-limit exhaustion at info (expected on free tier), other failures
	// at error (genuine outage).
	let lastFailure: FinnhubFailure | null = null;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;

		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (response.status === 429) {
				lastFailure = { reason: "rate_limited", status: 429 };
				if (!isLastAttempt) {
					const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
					await realDelay(computeRetryDelayMs(attempt, retryAfterMs));
					continue;
				}
				break;
			}

			if (!response.ok) {
				lastFailure = { reason: "api_error", status: response.status };
				if (!isLastAttempt) {
					await realDelay(computeRetryDelayMs(attempt, null));
					continue;
				}
				break;
			}

			return (await response.json()) as unknown;
		} catch (error) {
			const isTimeout =
				error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			const safeError =
				error instanceof Error
					? (() => {
							const sanitized = new Error(redactFinnhubToken(error.message));
							sanitized.name = error.name;
							if (error.stack) {
								sanitized.stack = redactFinnhubToken(error.stack);
							}
							return sanitized;
						})()
					: new Error(redactFinnhubToken(String(error)));
			lastFailure = isTimeout
				? { reason: "timeout", error: safeError }
				: { reason: "request_failed", error: safeError };
			if (!isLastAttempt) {
				await realDelay(computeRetryDelayMs(attempt, null));
				continue;
			}
			break;
		}
	}

	if (lastFailure) {
		const context: Record<string, unknown> = {
			endpoint,
			params,
			attempts: MAX_RETRIES,
			reason: lastFailure.reason,
		};
		if (lastFailure.reason === "rate_limited") {
			context.status = lastFailure.status;
			// Rate-limit exhaustion is an expected operational reality on
			// Finnhub's free tier — not pageable. Terminal state, no further
			// retry, so info (not warn) per project rule that warn requires
			// an escalation path.
			rootLogger.info(`Finnhub ${label} exhausted retries (rate limited)`, context);
		} else if (lastFailure.reason === "api_error") {
			context.status = lastFailure.status;
			context.category = failureCategory;
			const logFn = optional ? rootLogger.warn.bind(rootLogger) : rootLogger.error.bind(rootLogger);
			logFn(`Finnhub ${label} exhausted retries`, context);
		} else {
			context.category = failureCategory;
			if (optional) {
				rootLogger.warn(`Finnhub ${label} exhausted retries`, context);
			} else {
				rootLogger.error(`Finnhub ${label} exhausted retries`, context, lastFailure.error);
			}
		}
	}
	return null;
}

/* =============
Individual Fetchers
============= */

/** Fetch the latest analyst recommendation trend for a ticker (or `null`). */
export async function fetchRecommendationTrends(
	symbol: string,
	policy?: FinnhubFetchPolicy,
): Promise<{
	trend: RecommendationTrend | null;
	httpSucceeded: boolean;
}> {
	const data = await finnhubFetch("/stock/recommendation", { symbol }, "recommendation", policy);
	if (data === null) {
		return { trend: null, httpSucceeded: false };
	}
	if (!Array.isArray(data) || data.length === 0) {
		return { trend: null, httpSucceeded: true };
	}

	// Most recent recommendation period is first
	const latest = data[0] as Record<string, unknown>;
	const buy = latest.buy;
	const hold = latest.hold;
	const sell = latest.sell;
	const strongBuy = latest.strongBuy;
	const strongSell = latest.strongSell;
	const period = latest.period;

	if (
		typeof buy !== "number" ||
		typeof hold !== "number" ||
		typeof sell !== "number" ||
		typeof strongBuy !== "number" ||
		typeof strongSell !== "number" ||
		typeof period !== "string"
	) {
		rootLogger.error("Invalid Finnhub recommendation fields", {
			symbol,
			payload: latest,
		});
		return { trend: null, httpSucceeded: true };
	}

	return {
		trend: { buy, hold, sell, strongBuy, strongSell, period },
		httpSucceeded: true,
	};
}

function parseInsiderTransactionsPayload(
	symbol: string,
	data: unknown,
	cutoffDate: string | null,
	maxResults = 5,
): InsiderTransaction[] {
	if (typeof data !== "object" || data === null) {
		rootLogger.error("Invalid Finnhub insider-transactions payload shape", {
			symbol,
			payloadType: typeof data,
		});
		return [];
	}

	const transactions = (data as Record<string, unknown>).data;
	if (!Array.isArray(transactions)) {
		rootLogger.error("Invalid Finnhub insider-transactions data field", {
			symbol,
			dataType: typeof transactions,
		});
		return [];
	}

	return transactions
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).name === "string" &&
				typeof (item as Record<string, unknown>).change === "number" &&
				typeof (item as Record<string, unknown>).transactionDate === "string" &&
				(cutoffDate === null ||
					((item as Record<string, unknown>).transactionDate as string) >= cutoffDate),
		)
		.slice(0, maxResults)
		.map((item: Record<string, unknown>) => ({
			name: item.name as string,
			share: typeof item.share === "number" ? (item.share as number) : 0,
			change: item.change as number,
			transactionType:
				typeof item.transactionType === "string" ? (item.transactionType as string) : "",
			transactionDate: item.transactionDate as string,
		}));
}

/** Fetch insider transactions for a ticker (validated; optional date cutoff). */
export async function fetchInsiderTransactions(
	symbol: string,
	options?: { cutoffDate?: string | null; policy?: FinnhubFetchPolicy; maxResults?: number },
): Promise<InsiderTransaction[]> {
	const data = await finnhubFetch(
		"/stock/insider-transactions",
		{ symbol },
		"insider-transactions",
		options?.policy,
	);
	// `null` means finnhubFetch already logged the failure; don't double-log.
	if (data === null) return [];

	const cutoffDate =
		options?.cutoffDate === undefined
			? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
			: options.cutoffDate;

	return parseInsiderTransactionsPayload(symbol, data, cutoffDate, options?.maxResults ?? 5);
}

/* =============
Wrapper: Fetch all enabled Finnhub data for a set of tickers
============= */

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

/* =============
Formatting: Build context string from Finnhub news for Grok
============= */

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

/* =============
Formatting: Analyst consensus section
============= */

/** Format analyst recommendation trend data as a channel-appropriate text block. */
export function formatAnalystSection(
	data: Map<string, RecommendationTrend | null>,
	channel: DeliveryChannel,
): string | null {
	const lines: string[] = [];
	for (const [symbol, trend] of data) {
		if (!trend) continue;
		if (channel === "sms") {
			lines.push(`${symbol}: ${trend.buy} Buy, ${trend.hold} Hold, ${trend.sell} Sell`);
		} else {
			lines.push(
				`${symbol}: ${trend.strongBuy} Strong Buy, ${trend.buy} Buy, ${trend.hold} Hold, ${trend.sell} Sell, ${trend.strongSell} Strong Sell (${trend.period})`,
			);
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/* =============
Formatting: Insider transactions section
============= */

/** Format a share count compactly (e.g. 1200 -> "1k"). */
function formatShareCount(shares: number): string {
	const abs = Math.abs(shares);
	if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
	if (abs >= 1_000) return `${(abs / 1_000).toFixed(0)}k`;
	return abs.toLocaleString("en-US");
}

/** Format insider transaction data as a channel-appropriate text block. */
export function formatInsiderSection(
	data: Map<string, InsiderTransaction[]>,
	channel: DeliveryChannel,
): string | null {
	const lines: string[] = [];
	const maxPerTicker = channel === "sms" ? 2 : 5;

	for (const [symbol, transactions] of data) {
		if (transactions.length === 0) continue;
		const shown = transactions.slice(0, maxPerTicker);
		for (const tx of shown) {
			const action = tx.change > 0 ? "bought" : "sold";
			const shares = formatShareCount(tx.change);
			const date = tx.transactionDate.slice(5); // MM-DD
			lines.push(`${symbol}: ${tx.name} ${action} ${shares} shares (${date})`);
		}
	}
	if (lines.length > 0) return lines.join("\n");
	return null;
}
