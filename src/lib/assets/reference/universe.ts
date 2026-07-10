import { rootLogger } from "../../logging";
import { isRecord } from "../../types";
import { marketDataFetch } from "../../vendors/massive";
import type { ActiveTicker, ActiveUniverse } from "../types";
import {
	ACTIVE_TICKER_TYPES,
	MASSIVE_ALLOWED_HOST,
	MASSIVE_TICKERS_PATH_PREFIX,
} from "./constants";

interface ParsedTickerPage {
	tickers: ActiveTicker[];
	allActiveSymbols: Set<string>;
}

function validateNextUrl(nextUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(nextUrl);
	} catch {
		throw new Error(`Invalid next_url: not a valid URL (${nextUrl})`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(`Invalid next_url: must use https (got ${parsed.protocol})`);
	}
	if (parsed.host !== MASSIVE_ALLOWED_HOST) {
		throw new Error(`Invalid next_url: host must be ${MASSIVE_ALLOWED_HOST} (got ${parsed.host})`);
	}
	if (
		parsed.pathname !== MASSIVE_TICKERS_PATH_PREFIX &&
		!parsed.pathname.startsWith(`${MASSIVE_TICKERS_PATH_PREFIX}/`)
	) {
		throw new Error(
			`Invalid next_url: path must start with ${MASSIVE_TICKERS_PATH_PREFIX} (got ${parsed.pathname})`,
		);
	}
	return parsed;
}

function parseActiveTickerPage(
	results: unknown,
	normalizedType: "stock" | "etf",
	apiType: string,
): ParsedTickerPage {
	if (!Array.isArray(results)) {
		throw new Error(`Unexpected ticker list payload for type ${apiType}: missing results[]`);
	}

	const tickers: ActiveTicker[] = [];
	const allActiveSymbols = new Set<string>();
	for (const item of results) {
		if (!isRecord(item)) continue;
		const symbol = typeof item.ticker === "string" ? item.ticker.trim().toUpperCase() : "";
		if (!symbol) continue;

		// Delist safety keys on every symbol Massive returned from the requested
		// active type pages, even when the row cannot be inserted into `assets`.
		allActiveSymbols.add(symbol);

		const name = typeof item.name === "string" ? item.name.trim() : "";
		if (!name || symbol.includes(".")) continue;
		// Match the DB constraints (symbol varchar(10) + no-whitespace CHECK, name
		// varchar(255)): one malformed vendor row must not fail its whole insert chunk.
		if (symbol.length > 10 || /\s/.test(symbol)) continue;

		tickers.push({
			symbol,
			name: name.slice(0, 255),
			type: normalizedType,
		});
	}
	return { tickers, allActiveSymbols };
}

function paramsFromNextUrl(nextPageUrl: URL): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [key, value] of nextPageUrl.searchParams) {
		if (key === "apiKey") continue;
		params[key] = value;
	}
	return params;
}

async function listActiveTickersForType(
	apiType: string,
	normalizedType: "stock" | "etf",
): Promise<ParsedTickerPage | null> {
	const tickers: ActiveTicker[] = [];
	const allActiveSymbols = new Set<string>();
	const seenPageUrls = new Set<string>();
	let pagesFetched = 0;
	let params: Record<string, string> = {
		market: "stocks",
		active: "true",
		limit: "1000",
		type: apiType,
	};

	while (true) {
		const data = await marketDataFetch(MASSIVE_TICKERS_PATH_PREFIX, params, "active-tickers", {
			apiType,
		});
		if (!isRecord(data)) {
			if (pagesFetched === 0) return null;
			throw new Error(
				`Incomplete active-ticker fetch for type ${apiType}: provider returned no data mid-pagination (collected ${tickers.length})`,
			);
		}
		if (!Array.isArray(data.results) && pagesFetched === 0) {
			rootLogger.error("Massive active-tickers first page was missing results[]", {
				action: "fetch_active_tickers",
				apiType,
			});
			return null;
		}

		const page = parseActiveTickerPage(data.results, normalizedType, apiType);
		pagesFetched += 1;
		tickers.push(...page.tickers);
		for (const symbol of page.allActiveSymbols) allActiveSymbols.add(symbol);

		const nextUrl = data.next_url;
		if (nextUrl != null && typeof nextUrl !== "string") {
			throw new Error(`Unexpected ticker list payload for type ${apiType}: invalid next_url`);
		}
		if (typeof nextUrl !== "string" || nextUrl.length === 0) {
			return { tickers, allActiveSymbols };
		}

		const nextPageUrl = validateNextUrl(nextUrl);
		const canonicalPageUrl = (() => {
			const url = new URL(nextPageUrl.toString());
			url.searchParams.delete("apiKey");
			return url.toString();
		})();
		if (seenPageUrls.has(canonicalPageUrl)) {
			throw new Error(`Repeated ticker pagination URL for type ${apiType}`);
		}
		seenPageUrls.add(canonicalPageUrl);
		params = paramsFromNextUrl(nextPageUrl);
	}
}

/**
 * Fetch the complete active US stock/ETF universe from Massive's typed,
 * paginated reference endpoint. `allActiveSymbols` includes every valid ticker
 * string returned by the requested type pages, even when a row lacks a name or
 * fails the stricter `assets` insertion filters.
 */
export async function fetchActiveTickers(): Promise<ActiveUniverse> {
	const empty: ActiveUniverse = { tickers: [], allActiveSymbols: new Set() };
	const collected: ActiveTicker[] = [];
	const allActiveSymbols = new Set<string>();

	for (const { apiType, normalizedType } of ACTIVE_TICKER_TYPES) {
		const typeResult = await listActiveTickersForType(apiType, normalizedType);
		// A first-page transport failure makes the full universe untrustworthy.
		// Return empty so reconcile's load-bearing provider-failure gate aborts.
		if (typeResult === null) return empty;
		collected.push(...typeResult.tickers);
		for (const symbol of typeResult.allActiveSymbols) allActiveSymbols.add(symbol);
	}

	const seen = new Set<string>();
	const tickers: ActiveTicker[] = [];
	for (const ticker of collected) {
		if (seen.has(ticker.symbol)) continue;
		seen.add(ticker.symbol);
		tickers.push(ticker);
	}

	const duplicateCount = collected.length - tickers.length;
	if (duplicateCount > 0) {
		rootLogger.info("Massive active-tickers dedupe", {
			action: "fetch_active_tickers",
			collected: collected.length,
			unique: tickers.length,
			duplicates: duplicateCount,
		});
	}

	rootLogger.info("Massive active universe fetched", {
		action: "fetch_active_tickers",
		totalSymbols: allActiveSymbols.size,
		collectedTickers: collected.length,
		listedTickers: tickers.length,
		duplicates: duplicateCount,
	});
	return { tickers, allActiveSymbols };
}
