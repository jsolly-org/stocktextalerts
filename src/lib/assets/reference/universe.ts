import { rootLogger } from "../../logging";
import { isRecord } from "../../types";
import { marketDataFetch } from "../../vendors/massive";
import type { ActiveTicker } from "../types";
import {
	ACTIVE_TICKER_TYPES,
	MASSIVE_ALLOWED_HOST,
	MASSIVE_TICKERS_PATH_PREFIX,
} from "./constants";

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
): ActiveTicker[] {
	if (!Array.isArray(results)) {
		throw new Error(`Unexpected ticker list payload for type ${apiType}: missing results[]`);
	}
	const tickers: ActiveTicker[] = [];
	for (const item of results) {
		if (!isRecord(item)) continue;
		const rec = item;
		const symbol = typeof rec.ticker === "string" ? rec.ticker.trim().toUpperCase() : "";
		const name = typeof rec.name === "string" ? rec.name.trim() : "";

		if (!symbol || symbol.includes(".") || !name) continue;

		const lastUpdatedUtc = typeof rec.last_updated_utc === "string" ? rec.last_updated_utc : "";
		const compositeFigi =
			typeof rec.composite_figi === "string" && rec.composite_figi.trim() !== ""
				? rec.composite_figi
				: null;

		tickers.push({ symbol, name, type: normalizedType, lastUpdatedUtc, compositeFigi });
	}
	return tickers;
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
): Promise<ActiveTicker[]> {
	const tickers: ActiveTicker[] = [];
	const seenPageUrls = new Set<string>();
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
			throw new Error(
				`Incomplete active-ticker fetch for type ${apiType}: provider returned no data mid-pagination (collected ${tickers.length})`,
			);
		}

		const record = data;
		tickers.push(...parseActiveTickerPage(record.results, normalizedType, apiType));

		const nextUrl = record.next_url;
		if (nextUrl != null && typeof nextUrl !== "string") {
			throw new Error(`Unexpected ticker list payload for type ${apiType}: invalid next_url`);
		}
		if (typeof nextUrl !== "string" || nextUrl.length === 0) return tickers;

		const nextPageUrl = validateNextUrl(nextUrl);
		const canonicalPageUrl = (() => {
			const u = new URL(nextPageUrl.toString());
			u.searchParams.delete("apiKey");
			return u.toString();
		})();
		if (seenPageUrls.has(canonicalPageUrl)) {
			throw new Error(`Repeated ticker pagination URL for type ${apiType}`);
		}
		seenPageUrls.add(canonicalPageUrl);

		params = paramsFromNextUrl(nextPageUrl);
	}
}

/** Fetch the complete, de-duplicated active US stock/ETF universe from Massive. */
export async function fetchActiveTickers(): Promise<ActiveTicker[]> {
	const collected: ActiveTicker[] = [];
	for (const { apiType, normalizedType } of ACTIVE_TICKER_TYPES) {
		collected.push(...(await listActiveTickersForType(apiType, normalizedType)));
	}

	const seen = new Set<string>();
	const unique: ActiveTicker[] = [];
	for (const t of collected) {
		if (seen.has(t.symbol)) continue;
		seen.add(t.symbol);
		unique.push(t);
	}

	const duplicateCount = collected.length - unique.length;
	if (duplicateCount > 0) {
		rootLogger.info("Massive active-tickers dedupe", {
			action: "fetch_active_tickers",
			collected: collected.length,
			unique: unique.length,
			duplicates: duplicateCount,
		});
	}

	return unique;
}
