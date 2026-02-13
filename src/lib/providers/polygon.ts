import { rootLogger } from "../logging";

/** Delivery channel used to tune formatting verbosity. */
export type DeliveryChannel = "sms" | "email";

/* =============
Types
============= */

export interface PolygonEarningsEvent {
	ticker: string;
	date: string; // YYYY-MM-DD
	time: string | null; // UTC 24h format
	epsEstimate: number | null;
	revenueEstimate: number | null;
}

export interface PolygonDividendEvent {
	ticker: string;
	exDividendDate: string; // YYYY-MM-DD
	cashAmount: number;
	currency: string;
	payDate: string | null;
	frequency: number | null; // 1=annual, 2=semi, 4=quarterly, 12=monthly
}

export interface PolygonSplitEvent {
	ticker: string;
	executionDate: string; // YYYY-MM-DD
	splitFrom: number; // e.g. 1
	splitTo: number; // e.g. 10
	adjustmentType: string; // forward_split, reverse_split, stock_dividend
}

/* =============
Constants
============= */

const POLYGON_BASE_URL = "https://api.polygon.io";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

/* =============
Helpers
============= */

function getPolygonApiKey(): string {
	return import.meta.env.POLYGON_API_KEY ?? "";
}

function computeRetryDelayMs(
	attempt: number,
	retryAfterMs: number | null,
): number {
	if (retryAfterMs !== null) {
		return Math.min(retryAfterMs, 60_000);
	}
	const base = RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * base * 0.5;
	return base + jitter;
}

function parseRetryAfterMs(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1_000;
	}
	return null;
}

/**
 * Low-level Polygon fetch wrapper with retries, rate-limit handling, and timeouts.
 *
 * Returns `null` when the API key is missing or the request ultimately fails.
 */
export async function polygonFetch(
	endpoint: string,
	params: Record<string, string>,
	label: string,
): Promise<unknown> {
	const apiKey = getPolygonApiKey();
	if (!apiKey) return null;

	const query = new URLSearchParams({ ...params, apiKey });
	const url = `${POLYGON_BASE_URL}${endpoint}?${query.toString()}`;

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
				log(`Polygon ${label} rate limited (429)`, {
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
				log(`Polygon ${label} API error`, {
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

			return await response.json();
		} catch (error) {
			log(`Polygon ${label} request failed`, {
				endpoint,
				attempt,
				error: error instanceof Error ? error.message : String(error),
			});
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
Fetchers
============= */

/**
 * Fetch all earnings events for a date range (market-wide).
 */
export async function fetchPolygonEarnings(
	from: string,
	to: string,
): Promise<PolygonEarningsEvent[]> {
	// Polygon does not provide earnings on the core reference API; use a documented partner endpoint.
	// Benzinga earnings calendar response fields vary by plan — parse defensively and paginate when possible.
	const PAGE_SIZE = 100;
	const MAX_PAGES = 25;

	const toNumberOrNull = (value: unknown): number | null => {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	};
	const toStringOrNull = (value: unknown): string | null =>
		typeof value === "string" && value.trim() !== "" ? value : null;

	const parseNextUrl = (
		nextUrl: string,
	): { endpoint: string; params: Record<string, string> } | null => {
		try {
			// Polygon typically returns absolute URLs, but handle relative too.
			const u = new URL(nextUrl, POLYGON_BASE_URL);
			const params: Record<string, string> = {};
			for (const [k, v] of u.searchParams.entries()) {
				if (k === "apiKey") continue;
				params[k] = v;
			}
			return { endpoint: u.pathname, params };
		} catch {
			return null;
		}
	};

	const events: PolygonEarningsEvent[] = [];
	const seen = new Set<string>();

	let endpoint = "/benzinga/v1/earnings";
	let params: Record<string, string> = {
		date_from: from,
		date_to: to,
		pagesize: String(PAGE_SIZE),
		page: "1",
	};

	for (let pageCount = 0; pageCount < MAX_PAGES; pageCount++) {
		const data = await polygonFetch(endpoint, params, "earnings");
		if (typeof data !== "object" || data === null) break;

		const obj = data as Record<string, unknown>;
		const raw =
			(Array.isArray(obj.results) && obj.results) ||
			(Array.isArray(obj.earnings) && obj.earnings) ||
			(Array.isArray(obj.data) && obj.data) ||
			(Array.isArray(data) ? (data as unknown[]) : null);
		if (!raw) break;

		for (const item of raw) {
			if (typeof item !== "object" || item === null) continue;
			const row = item as Record<string, unknown>;

			const ticker = toStringOrNull(row.ticker) ?? toStringOrNull(row.symbol);
			const dateRaw =
				toStringOrNull(row.date) ??
				toStringOrNull(row.earnings_date) ??
				toStringOrNull(row.report_date) ??
				toStringOrNull(row.fiscal_date);
			if (!ticker || !dateRaw) continue;

			const date = dateRaw.slice(0, 10); // normalize YYYY-MM-DD when timestamps appear
			const time =
				toStringOrNull(row.time) ??
				toStringOrNull(row.hour) ??
				toStringOrNull(row.session);

			const epsEstimate =
				toNumberOrNull(row.eps_estimate) ??
				toNumberOrNull(row.eps_est) ??
				toNumberOrNull(row.epsEstimate) ??
				(typeof row.eps === "object" && row.eps !== null
					? (toNumberOrNull((row.eps as Record<string, unknown>).estimate) ??
						toNumberOrNull((row.eps as Record<string, unknown>).estimated))
					: null);
			const revenueEstimate =
				toNumberOrNull(row.revenue_estimate) ??
				toNumberOrNull(row.revenue_est) ??
				toNumberOrNull(row.revenueEstimate) ??
				(typeof row.revenue === "object" && row.revenue !== null
					? (toNumberOrNull(
							(row.revenue as Record<string, unknown>).estimate,
						) ??
						toNumberOrNull((row.revenue as Record<string, unknown>).estimated))
					: null);

			const key = `${ticker}|${date}`;
			if (seen.has(key)) continue;
			seen.add(key);

			events.push({
				ticker,
				date,
				time,
				epsEstimate,
				revenueEstimate,
			});
		}

		const nextUrl = toStringOrNull(obj.next_url);
		if (nextUrl) {
			const parsed = parseNextUrl(nextUrl);
			if (parsed) {
				endpoint = parsed.endpoint;
				params = parsed.params;
				continue;
			}
		}

		const nextPageRaw = obj.next_page;
		const nextPage =
			typeof nextPageRaw === "number" && Number.isFinite(nextPageRaw)
				? String(nextPageRaw)
				: toStringOrNull(nextPageRaw);
		if (nextPage) {
			params = { ...params, page: nextPage };
			continue;
		}

		// Fallback: if we received a full page, assume there might be more.
		if (raw.length >= PAGE_SIZE) {
			const currentPage = Number(params.page ?? "1");
			params = {
				...params,
				page: Number.isFinite(currentPage) ? String(currentPage + 1) : "2",
			};
			continue;
		}

		break;
	}

	return events;
}

/**
 * Fetch all ex-dividend events for a date range (market-wide).
 */
export async function fetchPolygonDividends(
	from: string,
	to: string,
): Promise<PolygonDividendEvent[]> {
	const data = await polygonFetch(
		"/v3/reference/dividends",
		{
			"ex_dividend_date.gte": from,
			"ex_dividend_date.lte": to,
			limit: "1000",
		},
		"dividends",
	);
	if (typeof data !== "object" || data === null) return [];

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return [];

	return results
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).ticker === "string" &&
				typeof (item as Record<string, unknown>).ex_dividend_date ===
					"string" &&
				typeof (item as Record<string, unknown>).cash_amount === "number",
		)
		.map((item: Record<string, unknown>) => ({
			ticker: item.ticker as string,
			exDividendDate: item.ex_dividend_date as string,
			cashAmount: item.cash_amount as number,
			currency: typeof item.currency === "string" ? item.currency : "USD",
			payDate: typeof item.pay_date === "string" ? item.pay_date : null,
			frequency: typeof item.frequency === "number" ? item.frequency : null,
		}));
}

/**
 * Fetch all stock splits for a date range (market-wide).
 */
export async function fetchPolygonSplits(
	from: string,
	to: string,
): Promise<PolygonSplitEvent[]> {
	const data = await polygonFetch(
		"/v3/reference/splits",
		{
			"execution_date.gte": from,
			"execution_date.lte": to,
			limit: "1000",
		},
		"splits",
	);
	if (typeof data !== "object" || data === null) return [];

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return [];

	return results
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).ticker === "string" &&
				typeof (item as Record<string, unknown>).execution_date === "string" &&
				typeof (item as Record<string, unknown>).split_from === "number" &&
				typeof (item as Record<string, unknown>).split_to === "number",
		)
		.map((item: Record<string, unknown>) => ({
			ticker: item.ticker as string,
			executionDate: item.execution_date as string,
			splitFrom: item.split_from as number,
			splitTo: item.split_to as number,
			adjustmentType:
				typeof item.adjustment_type === "string"
					? item.adjustment_type
					: "forward_split",
		}));
}

/* =============
Snapshot Quotes
============= */

/**
 * Snapshot ticker shape from Polygon `/v2/snapshot/locale/us/market/stocks/tickers`.
 */
interface PolygonSnapshotTicker {
	ticker: string;
	todaysChangePerc?: number;
	updated?: number; // nanoseconds
	day?: {
		o: number;
		h: number;
		l: number;
		c: number;
		v: number;
	};
	prevDay?: {
		c: number;
	};
}

export interface PolygonSnapshotQuote {
	price: number;
	changePercent: number;
	dayHigh: number | null;
	dayLow: number | null;
	dayOpen: number | null;
	prevClose: number | null;
	timestamp: number | null;
	volume: number | null;
}

function parseSnapshotTicker(
	t: PolygonSnapshotTicker,
): PolygonSnapshotQuote | null {
	const price = t.day?.c;
	if (typeof price !== "number" || !Number.isFinite(price) || price === 0)
		return null;

	const changePercent = t.todaysChangePerc;
	if (typeof changePercent !== "number" || !Number.isFinite(changePercent))
		return null;

	const numPrice = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null;
	const numVolume = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

	return {
		price,
		changePercent,
		dayHigh: numPrice(t.day?.h),
		dayLow: numPrice(t.day?.l),
		dayOpen: numPrice(t.day?.o),
		prevClose: numPrice(t.prevDay?.c),
		// Polygon `updated` is in nanoseconds — convert to seconds for consistency
		timestamp:
			typeof t.updated === "number" && Number.isFinite(t.updated)
				? Math.floor(t.updated / 1_000_000_000)
				: null,
		volume: numVolume(t.day?.v),
	};
}

/**
 * Batch-fetch snapshot quotes for a list of symbols via a single Polygon API call.
 *
 * Uses `/v2/snapshot/locale/us/market/stocks/tickers?tickers=A,B,C`.
 * Returns a Map keyed by symbol; missing/invalid tickers map to `null`.
 */
export async function fetchPolygonSnapshotQuotes(
	symbols: string[],
): Promise<Map<string, PolygonSnapshotQuote | null>> {
	const result = new Map<string, PolygonSnapshotQuote | null>();
	if (symbols.length === 0) return result;

	// Pre-fill with null so callers always see every requested symbol
	for (const s of symbols) result.set(s, null);

	const data = await polygonFetch(
		"/v2/snapshot/locale/us/market/stocks/tickers",
		{ tickers: symbols.join(",") },
		"snapshot-quotes",
	);

	if (typeof data !== "object" || data === null) return result;

	const tickers = (data as Record<string, unknown>).tickers;
	if (!Array.isArray(tickers)) return result;

	for (const raw of tickers) {
		if (typeof raw !== "object" || raw === null) continue;
		const t = raw as PolygonSnapshotTicker;
		if (typeof t.ticker !== "string") continue;

		const quote = parseSnapshotTicker(t);
		if (quote) {
			result.set(t.ticker, quote);
		}
	}

	return result;
}

/* =============
Formatting
============= */

/**
 * Format a revenue estimate compactly for display.
 */
function formatRevenue(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(1)}B`;
	if (abs >= 1_000_000) return `${Math.round(abs / 1_000_000)}M`;
	return abs.toLocaleString("en-US");
}

/**
 * Format a split ratio as a human-readable string (e.g. "10:1" or "1:5 reverse").
 */
function formatSplitRatio(
	splitFrom: number,
	splitTo: number,
	adjustmentType: string,
): string {
	const isReverse = adjustmentType === "reverse_split" || splitTo < splitFrom;
	if (isReverse) {
		return `${splitFrom}:${splitTo} reverse`;
	}
	return `${splitTo}:${splitFrom}`;
}

/** Map Polygon dividend frequency codes to labels. */
const FREQUENCY_LABELS: Record<number, string> = {
	1: "annual",
	2: "semi-annual",
	4: "quarterly",
	12: "monthly",
};

/**
 * Format asset events from the DB into a channel-appropriate text block.
 *
 * Events are grouped by type (earnings, dividends, splits).
 * Returns `null` when there are no events.
 */
/**
 * Format a countdown label for an event based on `daysUntil`.
 *
 * - 0 → "today"
 * - 1 → "tomorrow"
 * - 2+ → "in N days (MM-DD)"
 * - undefined → MM-DD (backward compatible)
 */
function formatDateLabel(
	eventDate: string,
	daysUntil: number | undefined,
): string {
	if (daysUntil === undefined) {
		return eventDate.slice(5); // MM-DD
	}
	if (daysUntil === 0) return "today";
	if (daysUntil === 1) return "tomorrow";
	return `in ${daysUntil} days (${eventDate.slice(5)})`;
}

/**
 * Format asset events from the DB into a channel-appropriate text block.
 *
 * Events are grouped by type (earnings, dividends, splits).
 * Returns `null` when there are no events.
 *
 * Each event may include an optional `daysUntil` field for countdown display:
 * - 0 → "today", 1 → "tomorrow", 2+ → "in N days (MM-DD)"
 * - When absent, existing MM-DD format is used (backward compatible).
 */
export function formatAssetEventsSection(
	events: Array<{
		symbol: string;
		event_type: "earnings" | "dividend" | "split";
		event_date: string;
		data: Record<string, unknown>;
		daysUntil?: number;
	}>,
	channel: DeliveryChannel,
): {
	earnings: string | null;
	dividends: string | null;
	splits: string | null;
} {
	const earningsLines: string[] = [];
	const dividendLines: string[] = [];
	const splitLines: string[] = [];

	for (const event of events) {
		const dateLabel = formatDateLabel(event.event_date, event.daysUntil);

		if (event.event_type === "earnings") {
			const time = event.data.time as string | null;
			const timeLabel = time ? ` (${time})` : "";
			if (channel === "sms") {
				earningsLines.push(
					`${event.symbol}: earnings ${dateLabel}${timeLabel}`,
				);
			} else {
				const estimates: string[] = [];
				const eps = event.data.epsEstimate as number | null;
				const rev = event.data.revenueEstimate as number | null;
				if (eps !== null && eps !== undefined)
					estimates.push(`EPS est. $${eps.toFixed(2)}`);
				if (rev !== null && rev !== undefined)
					estimates.push(`Rev est. $${formatRevenue(rev)}`);
				const estimateStr =
					estimates.length > 0 ? ` — ${estimates.join(", ")}` : "";
				earningsLines.push(
					`${event.symbol}: earnings ${dateLabel}${timeLabel}${estimateStr}`,
				);
			}
		} else if (event.event_type === "dividend") {
			const amount = event.data.cashAmount as number;
			const payDate = event.data.payDate as string | null;
			if (channel === "sms") {
				dividendLines.push(
					`${event.symbol}: ex-div ${dateLabel} $${amount.toFixed(2)}`,
				);
			} else {
				const payStr = payDate ? ` (pays ${payDate.slice(5)})` : "";
				const freq = event.data.frequency as number | null;
				const freqStr =
					freq && FREQUENCY_LABELS[freq] ? `, ${FREQUENCY_LABELS[freq]}` : "";
				dividendLines.push(
					`${event.symbol}: ex-div ${dateLabel} — $${amount.toFixed(2)}/share${payStr}${freqStr}`,
				);
			}
		} else if (event.event_type === "split") {
			const splitFrom = event.data.splitFrom as number;
			const splitTo = event.data.splitTo as number;
			const adjType = event.data.adjustmentType as string;
			const ratio = formatSplitRatio(splitFrom, splitTo, adjType);
			if (channel === "sms") {
				splitLines.push(`${event.symbol}: split ${dateLabel} ${ratio}`);
			} else {
				const isReverse = adjType === "reverse_split" || splitTo < splitFrom;
				const numericRatio = isReverse
					? `${splitFrom}:${splitTo}`
					: `${splitTo}:${splitFrom}`;
				const typeLabel = isReverse ? "reverse split" : "forward split";
				splitLines.push(
					`${event.symbol}: split ${dateLabel} — ${numericRatio} ${typeLabel}`,
				);
			}
		}
	}

	return {
		earnings: earningsLines.length > 0 ? earningsLines.join("\n") : null,
		dividends: dividendLines.length > 0 ? dividendLines.join("\n") : null,
		splits: splitLines.length > 0 ? splitLines.join("\n") : null,
	};
}
