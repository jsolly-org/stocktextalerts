import { FINNHUB_BASE_URL } from "./constants";
import { rootLogger } from "./logging";

/** Delivery channel used to tune formatting verbosity. */
export type DeliveryChannel = "sms" | "email";

/* =============
Types
============= */

export interface CompanyNewsItem {
	headline: string;
	summary: string;
	datetime: number;
	url: string;
	source: string;
}

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

export interface FinnhubExtrasData {
	news: Map<string, CompanyNewsItem[]>;
	analyst: Map<string, RecommendationTrend | null>;
	insider: Map<string, InsiderTransaction[]>;
}

export interface EarningsEvent {
	symbol: string;
	date: string;
	hour: "bmo" | "amc" | "dmh";
	epsEstimate: number | null;
	revenueEstimate: number | null;
}

export interface WeeklyCalendarData {
	earnings: Map<string, EarningsEvent[]>;
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

/**
 * Read the Finnhub API key from environment.
 *
 * Returns an empty string when unset so callers can treat "missing key" as "no data".
 */
function getFinnhubApiKey(): string {
	return import.meta.env.FINNHUB_API_KEY ?? "";
}

/**
 * Parse the `Retry-After` header value.
 *
 * Supports both delay-seconds (e.g. `"30"`) and HTTP-date formats.
 * Returns the delay in milliseconds, or `null` if the header is missing/unparseable.
 */
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

function redactFinnhubToken(value: string): string {
	return value.replace(/([?&]token=)[^&]+/gi, "$1[redacted]");
}

/**
 * Compute retry delay with exponential backoff and jitter.
 *
 * For 429 responses, respects `Retry-After` when available.
 */
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

/**
 * Low-level Finnhub fetch wrapper with retries, rate-limit handling, and timeouts.
 *
 * Returns `null` when the API key is missing or the request ultimately fails.
 */
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
			const reason =
				error instanceof Error && error.name === "TimeoutError"
					? "timeout"
					: "request_failed";
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
					: undefined;
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

/**
 * Fetch recent company news headlines for a ticker within a date range.
 *
 * Returns a small, validated subset of the Finnhub response (headline/summary/datetime).
 */
export async function fetchCompanyNews(
	symbol: string,
	from: string,
	to: string,
): Promise<CompanyNewsItem[]> {
	const data = await finnhubFetch(
		"/company-news",
		{ symbol, from, to },
		"company-news",
	);
	if (!Array.isArray(data)) return [];

	return data
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).headline === "string" &&
				typeof (item as Record<string, unknown>).datetime === "number",
		)
		.slice(0, 10)
		.map((item: Record<string, unknown>) => ({
			headline: item.headline as string,
			summary: typeof item.summary === "string" ? (item.summary as string) : "",
			datetime: item.datetime as number,
			url: typeof item.url === "string" ? (item.url as string) : "",
			source: typeof item.source === "string" ? (item.source as string) : "",
		}));
}

/**
 * Fetch the latest analyst recommendation trend for a ticker.
 *
 * Returns the most recent period if available; otherwise `null`.
 */
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

/**
 * Fetch recent insider transactions for a ticker.
 *
 * Returns a validated, capped list; invalid payloads yield an empty array.
 */
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
Calendar Fetchers: Earnings
============= */

/**
 * Fetch the global earnings calendar for a date range.
 *
 * Finnhub returns a large list; callers should filter down to the user's symbols.
 */
export async function fetchEarningsCalendar(
	from: string,
	to: string,
): Promise<EarningsEvent[]> {
	const data = await finnhubFetch(
		"/calendar/earnings",
		{ from, to },
		"earnings-calendar",
	);
	if (typeof data !== "object" || data === null) return [];

	const calendar = (data as Record<string, unknown>).earningsCalendar;
	if (!Array.isArray(calendar)) return [];

	return calendar
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).symbol === "string" &&
				typeof (item as Record<string, unknown>).date === "string",
		)
		.map((item: Record<string, unknown>) => ({
			symbol: item.symbol as string,
			date: item.date as string,
			hour: (typeof item.hour === "string" ? item.hour : "dmh") as
				| "bmo"
				| "amc"
				| "dmh",
			epsEstimate:
				typeof item.epsEstimate === "number" ? item.epsEstimate : null,
			revenueEstimate:
				typeof item.revenueEstimate === "number" ? item.revenueEstimate : null,
		}));
}

/**
 * Fetch weekly calendar data (earnings) for a set of symbols.
 *
 * Earnings are fetched once globally and filtered to the user's symbols.
 */
export async function fetchWeeklyCalendarData(
	symbols: string[],
	weekStart: string,
	weekEnd: string,
): Promise<WeeklyCalendarData> {
	const result: WeeklyCalendarData = {
		earnings: new Map(),
	};

	if (symbols.length === 0) return result;

	// Earnings calendar is a single global call — filter to user's symbols after
	const allEarnings = await fetchEarningsCalendar(weekStart, weekEnd);
	const symbolSet = new Set(symbols);
	for (const event of allEarnings) {
		if (!symbolSet.has(event.symbol)) continue;
		const existing = result.earnings.get(event.symbol) ?? [];
		existing.push(event);
		result.earnings.set(event.symbol, existing);
	}

	return result;
}

/* =============
Wrapper: Fetch all enabled Finnhub data for a set of tickers
============= */

/**
 * Fetch enabled Finnhub "extras" data (news/analyst/insider) for a set of symbols.
 *
 * Requests are batched per symbol (parallel within symbol, sequential across symbols)
 * with small inter-request delays to reduce rate-limit pressure.
 */
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

/**
 * Build a compact, line-based context string from recent news headlines for Grok.
 *
 * Format: one line per headline, prefixed by ticker (e.g. `AAPL: ...`).
 */
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

/**
 * Format analyst recommendation trend data as a channel-appropriate text block.
 *
 * Returns `null` when no tickers have usable trend data.
 */
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

/**
 * Format a share count compactly for display.
 *
 * Example: 1200 -> "1k", 2500000 -> "2.5M".
 */
function formatShareCount(shares: number): string {
	const abs = Math.abs(shares);
	if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
	if (abs >= 1_000) return `${(abs / 1_000).toFixed(0)}k`;
	return abs.toLocaleString("en-US");
}

/* =============
Formatting: Earnings section for weekly calendar
============= */

const HOUR_LABELS: Record<string, string> = {
	bmo: "before open",
	amc: "after close",
	dmh: "during market hours",
};

/**
 * Format earnings calendar events as a channel-appropriate text block.
 *
 * Returns `null` when there are no earnings events to include.
 */
export function formatEarningsSection(
	data: Map<string, EarningsEvent[]>,
	channel: DeliveryChannel,
): string | null {
	const lines: string[] = [];
	for (const [symbol, events] of data) {
		if (events.length === 0) continue;
		for (const event of events) {
			const dateStr = event.date.slice(5); // MM-DD
			const hourLabel = HOUR_LABELS[event.hour] ?? "";
			if (channel === "sms") {
				const suffix = hourLabel ? ` (${hourLabel})` : "";
				lines.push(`${symbol}: ${dateStr}${suffix}`);
			} else {
				const suffix = hourLabel ? ` (${hourLabel})` : "";
				const estimates: string[] = [];
				if (event.epsEstimate !== null)
					estimates.push(`EPS est. $${event.epsEstimate.toFixed(2)}`);
				if (event.revenueEstimate !== null)
					estimates.push(`Rev est. $${formatRevenue(event.revenueEstimate)}`);
				const estimateStr =
					estimates.length > 0 ? ` — ${estimates.join(", ")}` : "";
				lines.push(`${symbol}: ${dateStr}${suffix}${estimateStr}`);
			}
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Format a revenue estimate compactly for display.
 *
 * Example: 1250000000 -> "1.3B", 7500000 -> "8M".
 */
function formatRevenue(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(0)}M`;
	return abs.toLocaleString("en-US");
}

/**
 * Format insider transaction data as a channel-appropriate text block.
 *
 * Returns `null` when there are no insider transactions to include.
 */
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
