import { FINNHUB_BASE_URL } from "./constants";
import type { GrokChannel } from "./grok-extras";
import { rootLogger } from "./logging";

/* =============
Types
============= */

export interface CompanyNewsItem {
	headline: string;
	summary: string;
	datetime: number;
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

export interface DividendEvent {
	symbol: string;
	exDate: string;
	payDate: string;
	amount: number;
	currency: string;
}

export interface WeeklyCalendarData {
	earnings: Map<string, EarningsEvent[]>;
	dividends: Map<string, DividendEvent[]>;
}

/* =============
Constants
============= */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const INTER_REQUEST_DELAY_MS = 100;

/* =============
Helpers
============= */

function getFinnhubApiKey(): string {
	return import.meta.env.FINNHUB_API_KEY ?? "";
}

async function finnhubFetch(
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
			const response = await fetch(url);
			if (!response.ok) {
				log(`Finnhub ${label} API error`, {
					attempt,
					status: response.status,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return null;
			}

			const data: unknown = await response.json();
			return data;
		} catch (error) {
			log(`Failed to fetch Finnhub ${label}`, { attempt }, error);
			if (!isLastAttempt) {
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
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
		}));
}

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

	return transactions
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).name === "string" &&
				typeof (item as Record<string, unknown>).change === "number" &&
				typeof (item as Record<string, unknown>).transactionDate === "string",
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
Calendar Fetchers: Earnings + Dividends
============= */

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

export async function fetchStockDividends(
	symbol: string,
	from: string,
	to: string,
): Promise<DividendEvent[]> {
	const data = await finnhubFetch(
		"/stock/dividend",
		{ symbol, from, to },
		"stock-dividend",
	);
	if (!Array.isArray(data)) return [];

	return data
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).exDate === "string" &&
				typeof (item as Record<string, unknown>).amount === "number",
		)
		.map((item: Record<string, unknown>) => ({
			symbol:
				typeof item.symbol === "string" ? (item.symbol as string) : symbol,
			exDate: item.exDate as string,
			payDate: typeof item.payDate === "string" ? (item.payDate as string) : "",
			amount: item.amount as number,
			currency:
				typeof item.currency === "string" ? (item.currency as string) : "USD",
		}));
}

export async function fetchWeeklyCalendarData(
	symbols: string[],
	weekStart: string,
	weekEnd: string,
): Promise<WeeklyCalendarData> {
	const result: WeeklyCalendarData = {
		earnings: new Map(),
		dividends: new Map(),
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

	// Dividends are per-symbol
	for (const symbol of symbols) {
		const dividends = await fetchStockDividends(symbol, weekStart, weekEnd);
		if (dividends.length > 0) {
			result.dividends.set(symbol, dividends);
		}
		await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
	}

	return result;
}

/* =============
Wrapper: Fetch all enabled Finnhub data for a set of tickers
============= */

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

export function buildNewsContextForGrok(
	newsData: Map<string, CompanyNewsItem[]>,
): string {
	const lines: string[] = [];
	for (const [symbol, items] of newsData) {
		if (items.length === 0) continue;
		for (const item of items) {
			lines.push(`${symbol}: ${item.headline}`);
		}
	}
	return lines.join("\n");
}

/* =============
Formatting: Analyst consensus section
============= */

export function formatAnalystSection(
	data: Map<string, RecommendationTrend | null>,
	channel: GrokChannel,
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

export function formatEarningsSection(
	data: Map<string, EarningsEvent[]>,
	channel: GrokChannel,
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

function formatRevenue(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(0)}M`;
	return abs.toLocaleString("en-US");
}

/* =============
Formatting: Dividends section for weekly calendar
============= */

export function formatDividendsSection(
	data: Map<string, DividendEvent[]>,
	channel: GrokChannel,
): string | null {
	const lines: string[] = [];
	for (const [symbol, events] of data) {
		if (events.length === 0) continue;
		for (const event of events) {
			const exDateStr = event.exDate.slice(5); // MM-DD
			if (channel === "sms") {
				lines.push(
					`${symbol}: Ex-div ${exDateStr}, $${event.amount.toFixed(2)}`,
				);
			} else {
				const payDateStr = event.payDate
					? `, pay ${event.payDate.slice(5)}`
					: "";
				lines.push(
					`${symbol}: Ex-div ${exDateStr}${payDateStr}, $${event.amount.toFixed(2)} ${event.currency}`,
				);
			}
		}
	}
	return lines.length > 0 ? lines.join("\n") : null;
}

export function formatInsiderSection(
	data: Map<string, InsiderTransaction[]>,
	channel: GrokChannel,
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
	return lines.length > 0 ? lines.join("\n") : null;
}
