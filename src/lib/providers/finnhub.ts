import { FINNHUB_BASE_URL } from "../constants";
import { rootLogger } from "../logging";
import { type CompanyNewsItem, fetchCompanyNews } from "./company-news";

export { type CompanyNewsItem, fetchCompanyNews };

/** Delivery channel used to tune formatting verbosity. */
export type DeliveryChannel = "sms" | "email";

/* =============
Types
============= */

/** Analyst recommendation trend totals for a given period. */
export interface RecommendationTrend {
	buy: number;
	hold: number;
	sell: number;
	strongBuy: number;
	strongSell: number;
	period: string;
}

/** Normalized insider transaction entry. */
export interface InsiderTransaction {
	name: string;
	share: number;
	change: number;
	transactionType: string;
	transactionDate: string;
}

/** Batch “extras” data fetched from Finnhub for a set of symbols. */
export interface FinnhubExtrasData {
	news: Map<string, CompanyNewsItem[]>;
	analyst: Map<string, RecommendationTrend | null>;
	insider: Map<string, InsiderTransaction[]>;
}

/* =============
Constants
============= */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const INTER_REQUEST_DELAY_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;

/* =============
Helpers
============= */

/** Read the Finnhub API key from env (or return empty string). */
function getFinnhubApiKey(): string {
	return import.meta.env.FINNHUB_API_KEY ?? "";
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
function computeRetryDelayMs(
	attempt: number,
	retryAfterMs: number | null,
): number {
	if (retryAfterMs !== null) {
		// Cap Retry-After at 60 s to avoid excessively long waits.
		return Math.min(retryAfterMs, 60_000);
	}
	const base = RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * base * 0.5;
	return base + jitter;
}

/** Low-level Finnhub fetch wrapper with retries, timeouts, and rate-limit handling. */
export async function finnhubFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
): Promise<unknown> {
	const apiKey = getFinnhubApiKey();
	if (!apiKey) return null;

	const query = new URLSearchParams({ ...params, token: apiKey });
	const url = `${FINNHUB_BASE_URL}${endpoint}?${query.toString()}`;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		const log = isLastAttempt
			? rootLogger.error.bind(rootLogger)
			: rootLogger.warn.bind(rootLogger);

		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (response.status === 429) {
				const retryAfterMs = parseRetryAfterMs(
					response.headers.get("Retry-After"),
				);
				log(`Finnhub ${label} rate limited (429)`, {
					endpoint,
					attempt,
					status: 429,
				});
				if (!isLastAttempt) {
					await new Promise((r) =>
						setTimeout(r, computeRetryDelayMs(attempt, retryAfterMs)),
					);
					continue;
				}
				return null;
			}

			if (!response.ok) {
				log(`Finnhub ${label} API error`, {
					endpoint,
					attempt,
					status: response.status,
				});
				if (!isLastAttempt) {
					await new Promise((r) =>
						setTimeout(r, computeRetryDelayMs(attempt, null)),
					);
					continue;
				}
				return null;
			}

			const data: unknown = await response.json();
			return data;
		} catch (error) {
			const isTimeout =
				error instanceof Error &&
				(error.name === "TimeoutError" || error.name === "AbortError");
			const reason = isTimeout ? "timeout" : "request_failed";
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
			log(
				`Failed to fetch Finnhub ${label}`,
				{ endpoint, attempt, reason },
				safeError,
			);
			if (!isLastAttempt) {
				await new Promise((r) =>
					setTimeout(r, computeRetryDelayMs(attempt, null)),
				);
				continue;
			}
			return null;
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
): Promise<RecommendationTrend | null> {
	const data = await finnhubFetch(
		"/stock/recommendation",
		{ symbol },
		"recommendation",
	);
	if (!Array.isArray(data) || data.length === 0) return null;

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
		rootLogger.warn("Invalid Finnhub recommendation fields", {
			symbol,
			payload: latest,
		});
		return null;
	}

	return { buy, hold, sell, strongBuy, strongSell, period };
}

/** Fetch recent insider transactions for a ticker (validated and capped). */
export async function fetchInsiderTransactions(
	symbol: string,
): Promise<InsiderTransaction[]> {
	const data = await finnhubFetch(
		"/stock/insider-transactions",
		{ symbol },
		"insider-transactions",
	);
	if (typeof data !== "object" || data === null) return [];

	const transactions = (data as Record<string, unknown>).data;
	if (!Array.isArray(transactions)) return [];

	// Only include transactions from the last 24 hours
	const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	return transactions
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).name === "string" &&
				typeof (item as Record<string, unknown>).change === "number" &&
				typeof (item as Record<string, unknown>).transactionDate === "string" &&
				((item as Record<string, unknown>).transactionDate as string) >=
					cutoffDate,
		)
		.slice(0, 5)
		.map((item: Record<string, unknown>) => ({
			name: item.name as string,
			share: typeof item.share === "number" ? (item.share as number) : 0,
			change: item.change as number,
			transactionType:
				typeof item.transactionType === "string"
					? (item.transactionType as string)
					: "",
			transactionDate: item.transactionDate as string,
		}));
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
	};

	if (symbols.length === 0) return result;
	if (
		!options.includeNews &&
		!options.includeAnalyst &&
		!options.includeInsider
	)
		return result;

	// Date range for company news: last 3 days
	const now = new Date();
	const to = now.toISOString().slice(0, 10);
	const from = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	// Fetch sequentially per symbol with small delays to stay within rate limits
	for (const symbol of symbols) {
		const fetches: Promise<void>[] = [];

		if (options.includeNews) {
			fetches.push(
				fetchCompanyNews(symbol, from, to).then((data) => {
					result.news.set(symbol, data);
				}),
			);
		}

		if (options.includeAnalyst) {
			fetches.push(
				fetchRecommendationTrends(symbol).then((data) => {
					result.analyst.set(symbol, data);
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
		await Promise.all(fetches);
		await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
	}

	return result;
}

/* =============
Formatting: Build context string from Finnhub news for Grok
============= */

/** Build a compact, line-based news context string for Grok. */
export function buildNewsContextForGrok(
	newsData: Map<string, CompanyNewsItem[]>,
): string {
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
			lines.push(
				`${symbol}: ${trend.buy} Buy, ${trend.hold} Hold, ${trend.sell} Sell`,
			);
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
	if (data.size > 0) return "No reported insider trades in the last 24 hours.";
	return null;
}
