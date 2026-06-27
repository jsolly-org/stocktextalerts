import { sicCodeToSector } from "../../assets/sector-mapping";
import { rootLogger } from "../../logging";
import { shouldSkipVendorHttpInTestMode } from "../fetch";
import { marketDataFetch } from "./client";

export interface ProviderResult<T> {
	data: T[];
	failed: boolean;
}

interface DividendEvent {
	ticker: string;
	exDividendDate: string; // YYYY-MM-DD
	cashAmount: number;
	currency: string;
	payDate: string | null;
	frequency: number | null; // 1=annual, 2=semi, 4=quarterly, 12=monthly
}

interface SplitEvent {
	ticker: string;
	executionDate: string; // YYYY-MM-DD
	splitFrom: number; // e.g. 1
	splitTo: number; // e.g. 10
	adjustmentType: string; // forward_split, reverse_split, stock_dividend
}

interface IpoEvent {
	ticker: string;
	listingDate: string; // YYYY-MM-DD
	issuerName: string | null;
	securityType: string | null;
}

/**
 * Fetch all ex-dividend events for a date range (market-wide).
 */
export async function fetchDividends(
	from: string,
	to: string,
): Promise<ProviderResult<DividendEvent>> {
	const data = await marketDataFetch(
		"/v3/reference/dividends",
		{
			"ex_dividend_date.gte": from,
			"ex_dividend_date.lte": to,
			limit: "1000",
		},
		"dividends",
	);
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as Record<string, unknown>).ticker === "string" &&
					typeof (item as Record<string, unknown>).ex_dividend_date === "string" &&
					typeof (item as Record<string, unknown>).cash_amount === "number",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				exDividendDate: item.ex_dividend_date as string,
				cashAmount: item.cash_amount as number,
				currency: typeof item.currency === "string" ? item.currency : "USD",
				payDate: typeof item.pay_date === "string" ? item.pay_date : null,
				frequency: typeof item.frequency === "number" ? item.frequency : null,
			})),
		failed: false,
	};
}

/**
 * Fetch all stock splits for a date range (market-wide).
 */
export async function fetchSplits(from: string, to: string): Promise<ProviderResult<SplitEvent>> {
	const data = await marketDataFetch(
		"/v3/reference/splits",
		{
			"execution_date.gte": from,
			"execution_date.lte": to,
			limit: "1000",
		},
		"splits",
	);
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
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
					typeof item.adjustment_type === "string" ? item.adjustment_type : "forward_split",
			})),
		failed: false,
	};
}

/**
 * Fetch upcoming IPO events for a date range (market-wide).
 */
export async function fetchIpos(from: string, to: string): Promise<ProviderResult<IpoEvent>> {
	const data = await marketDataFetch(
		"/vX/reference/ipos",
		{
			"listing_date.gte": from,
			"listing_date.lte": to,
			limit: "1000",
		},
		"ipos",
	);
	if (data === null) return { data: [], failed: true };
	if (typeof data !== "object") return { data: [], failed: false };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as Record<string, unknown>).ticker === "string" &&
					typeof (item as Record<string, unknown>).listing_date === "string",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				listingDate: item.listing_date as string,
				issuerName: typeof item.issuer_name === "string" ? item.issuer_name : null,
				securityType: typeof item.security_type === "string" ? item.security_type : null,
			})),
		failed: false,
	};
}

/**
 * Authoritative delisting record for a single symbol, as returned by
 * Massive's reference-tickers endpoint.
 */
export interface TickerReferenceResult {
	symbol: string;
	active: false;
	/** YYYY-MM-DD — always present in a `delisted` status. */
	delistedUtc: string;
	primaryExchange: string | null;
	name: string | null;
}

/**
 * Discriminated result of a single reference lookup:
 * - `delisted` — Massive explicitly returned `active: false` with a `delisted_utc`.
 * - `unknown` — Massive returned no results, OR a result without the strict
 *   delisting fields. Treat as "still listed or not in Massive." Must NOT
 *   be interpreted as a delisting signal (OTC/SPAC pre-listing tickers fall
 *   into this bucket).
 * - `provider_error` — Transient fetch failure after retries. Caller should
 *   skip this symbol without changing state and retry on the next run.
 */
export type TickerReferenceStatus =
	| { status: "delisted"; result: TickerReferenceResult }
	| { status: "unknown"; symbol: string }
	| { status: "provider_error"; symbol: string };

/**
 * Look up a single symbol in Massive's reference-tickers endpoint filtered
 * to `active=false`.
 *
 * Uses `/v3/reference/tickers?ticker={symbol}&active=false&limit=1`. When
 * the ticker is still active (or unknown to Massive), the endpoint returns
 * an empty `results` array, and this function yields `{status: "unknown"}`.
 *
 * Strict validation: only returns `{status: "delisted"}` when the response
 * row has `active === false` AND a `delisted_utc` string of length ≥ 10.
 * Everything else is `unknown` — never infer a delisting from absence.
 */
async function fetchTickerReference(symbol: string): Promise<TickerReferenceStatus> {
	const data = await marketDataFetch(
		"/v3/reference/tickers",
		{ ticker: symbol, active: "false", limit: "1" },
		"ticker-reference",
		{ symbol },
	);

	if (data === null) return { status: "provider_error", symbol };
	if (typeof data !== "object") return { status: "unknown", symbol };

	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results) || results.length === 0) {
		return { status: "unknown", symbol };
	}

	const first = results[0];
	if (typeof first !== "object" || first === null) {
		return { status: "unknown", symbol };
	}
	const row = first as Record<string, unknown>;

	if (row.active !== false) return { status: "unknown", symbol };

	const rawDelistedUtc = row.delisted_utc;
	if (typeof rawDelistedUtc !== "string" || rawDelistedUtc.length < 10) {
		return { status: "unknown", symbol };
	}

	return {
		status: "delisted",
		result: {
			symbol,
			active: false,
			delistedUtc: rawDelistedUtc.slice(0, 10),
			primaryExchange: typeof row.primary_exchange === "string" ? row.primary_exchange : null,
			name: typeof row.name === "string" ? row.name : null,
		},
	};
}

/**
 * Concurrent reference lookup for multiple symbols with bounded parallelism.
 *
 * Returns one status per input symbol; order is not guaranteed.
 * Mirrors the worker-pool pattern used by `fetchSparklines` in
 * `src/lib/market-data/types.ts`.
 */
export async function fetchTickerReferences(
	symbols: string[],
	concurrency = 5,
): Promise<TickerReferenceStatus[]> {
	if (symbols.length === 0) return [];
	const results: TickerReferenceStatus[] = [];
	const queue = [...symbols];

	async function worker(): Promise<void> {
		while (true) {
			const next = queue.shift();
			if (next === undefined) return;
			results.push(await fetchTickerReference(next));
		}
	}

	const workerCount = Math.min(concurrency, symbols.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

const MASSIVE_ALLOWED_HOST = "api.massive.com";
const MASSIVE_TICKERS_PATH_PREFIX = "/v3/reference/tickers";

/**
 * Massive ticker types we surface, mapped to our normalized types. The list
 * endpoint is queried per `apiType`, so the normalized type is known from the
 * loop rather than parsed from each row. (Module-private; `scripts/db/fetch-us-assets.ts`
 * keeps its own copy pending a DRY pass — see the plan's out-of-scope.)
 */
const ACTIVE_TICKER_TYPES: ReadonlyArray<{
	apiType: string;
	normalizedType: "stock" | "etf";
}> = [
	{ apiType: "CS", normalizedType: "stock" },
	{ apiType: "ADRC", normalizedType: "stock" },
	{ apiType: "OS", normalizedType: "stock" },
	{ apiType: "ETF", normalizedType: "etf" },
	{ apiType: "ETN", normalizedType: "etf" },
	{ apiType: "ETV", normalizedType: "etf" },
	{ apiType: "ETS", normalizedType: "etf" },
];

/** One active-universe row from Massive's list endpoint. Only fields the reconcile reads. */
export interface ActiveTicker {
	/** rec.ticker, trimmed + UPPERCASED. */
	symbol: string;
	/** rec.name, trimmed. */
	name: string;
	/** Normalized from the apiType loop (CS/ADRC/OS → stock; ETF/ETN/ETV/ETS → etf). */
	type: "stock" | "etf";
	/** rec.last_updated_utc — ISO ts, always present per the verified contract; "" defensively. */
	lastUpdatedUtc: string;
	/** rec.composite_figi — present on most rows; captured opportunistically. */
	compositeFigi: string | null;
}

/**
 * Validate that a pagination `next_url` is safe to follow (same host + path prefix).
 * Prevents secret exfiltration if `next_url` is ever untrusted (compromised upstream).
 * @throws Error if the URL is invalid or points outside api.massive.com's tickers endpoint.
 */
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

/** Parse one list-endpoint page's `results[]` into `ActiveTicker`s for a known normalized type. */
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
		if (typeof item !== "object" || item === null) continue;
		const rec = item as Record<string, unknown>;
		const symbol = typeof rec.ticker === "string" ? rec.ticker.trim().toUpperCase() : "";
		const name = typeof rec.name === "string" ? rec.name.trim() : "";

		// Skip dotted symbols (e.g. BRK.A) and empty names — same filter as the seed script.
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

/** Reconstruct `marketDataFetch` params (apiKey-free) from a validated `next_url`. */
function paramsFromNextUrl(nextPageUrl: URL): Record<string, string> {
	const params: Record<string, string> = {};
	for (const [key, value] of nextPageUrl.searchParams) {
		if (key === "apiKey") continue;
		params[key] = value;
	}
	return params;
}

/**
 * Paginate the Massive active-tickers list endpoint for a single `apiType`.
 *
 * Reuses `marketDataFetch` (429/Retry-After/timeout/logging) per page. The first
 * page is a fresh request; subsequent pages reconstruct params from the validated
 * `next_url` and re-invoke `marketDataFetch` against the same endpoint path.
 *
 * Returns `[]` in test mode (`marketDataFetch` short-circuits and yields `null`).
 */
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

		// Past fetchActiveTickers' test-mode short-circuit, a null/non-object here is a real
		// provider failure (exhausted retries or a final 429) MID-pagination. Returning the
		// partial set collected so far would let the reconcile flag the dropped tail as
		// delisted — mass false-delisting of live symbols. Fail closed: throw so the whole
		// reconcile aborts before any mutation and retries next run.
		if (data === null || typeof data !== "object") {
			throw new Error(
				`Incomplete active-ticker fetch for type ${apiType}: provider returned no data mid-pagination (collected ${tickers.length})`,
			);
		}

		const record = data as Record<string, unknown>;
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

/**
 * Fetch the complete, de-duplicated active US stock/ETF universe from Massive's
 * list endpoint (the display-eligible subset already filtered: known types,
 * no dotted symbols, non-empty names).
 *
 * Queries each `apiType` in `ACTIVE_TICKER_TYPES` order; on duplicate symbols the
 * first occurrence wins (so a symbol listed as both CS and ETF keeps `stock`).
 * Returns `[]` in test mode — the reconcile module is exercised via its injection
 * seam, not this function, so the local suite never hits the network.
 */
export async function fetchActiveTickers(): Promise<ActiveTicker[]> {
	// Test-mode short-circuit: the reconcile is exercised via its injection seam, so this
	// returns an empty universe rather than hitting the network. Doing it here (not relying
	// on marketDataFetch's per-call guard) means a null from listActiveTickersForType below
	// can only signal a real mid-pagination failure, never test mode.
	if (shouldSkipVendorHttpInTestMode("massive")) return [];
	const collected: ActiveTicker[] = [];
	for (const { apiType, normalizedType } of ACTIVE_TICKER_TYPES) {
		collected.push(...(await listActiveTickersForType(apiType, normalizedType)));
	}

	// Dedupe by symbol, first occurrence wins. Duplicates are expected and benign.
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

/**
 * Fetch enrichment detail for a single ticker: `branding.icon_url` and
 * `sic_code → sector`. Reuses `marketDataFetch` (retries/429/timeout).
 *
 * Returns `{ ok: false, ... }` on a provider failure (so callers skip the
 * symbol without nulling existing data) and `{ ok: true, ... }` otherwise,
 * with `iconUrl`/`sector` null when Massive omits them.
 */
export async function fetchTickerDetail(
	symbol: string,
): Promise<{ ok: boolean; iconUrl: string | null; sector: string | null }> {
	const data = await marketDataFetch(
		`${MASSIVE_TICKERS_PATH_PREFIX}/${encodeURIComponent(symbol)}`,
		{},
		"ticker-details",
		{ symbol },
	);

	if (typeof data !== "object" || data === null) {
		return { ok: false, iconUrl: null, sector: null };
	}

	const results = (data as Record<string, unknown>).results;
	if (typeof results !== "object" || results === null) {
		return { ok: false, iconUrl: null, sector: null };
	}

	const rec = results as Record<string, unknown>;
	const sicCode = rec.sic_code;
	const branding = rec.branding;

	let iconUrl: string | null = null;
	if (typeof branding === "object" && branding !== null) {
		const url = (branding as Record<string, unknown>).icon_url;
		if (typeof url === "string" && url.trim() !== "") {
			iconUrl = url;
		}
	}

	let sector: string | null = null;
	if (typeof sicCode === "string" || typeof sicCode === "number") {
		sector = sicCodeToSector(String(sicCode));
	}

	return { ok: true, iconUrl, sector };
}
