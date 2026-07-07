/**
 * Fetch all US assets (stocks, ETFs) via Massive API and write
 * to scripts/data/us-assets.json.
 *
 * DELIBERATE DIVERGENCE from prod: since 2026-07 the production universe
 * reconcile sources Finnhub /stock/symbol (src/lib/assets/reference/universe.ts),
 * while this LOCAL-SEED-ONLY generator still paginates Massive (proper-case
 * names, richer branding for fixtures). It runs manually and rarely — at the
 * free tier's 5/min this regeneration takes hours; don't run it casually, and
 * don't treat its output shape as what prod reconcile produces.
 *
 * Two-pass approach:
 *   Pass 1 — List tickers: Paginate /v3/reference/tickers for each type.
 *   Pass 2 — Fetch details: For each ticker, call /v3/reference/tickers/{symbol}
 *            to get branding.icon_url.
 *
 * Type mapping:
 *   CS, ADRC, OS → "stock"
 *   ETF, ETN, ETV, ETS → "etf"
 *
 * Requires MASSIVE_API_KEY in .env.local (loaded via --env-file-if-exists).
 *
 * Usage:
 *   npx tsx scripts/db/fetch-us-assets.ts
 *   # or via package.json script:
 *   npm run db:fetch-assets
 */

import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { marketDataFetch } from "../../src/lib/vendors/massive";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "..", "data", "us-assets.json");

const MASSIVE_BASE_URL = "https://api.massive.com";
const MASSIVE_ALLOWED_HOST = "api.massive.com";
const MASSIVE_TICKERS_PATH_PREFIX = "/v3/reference/tickers";

// Massive ticker types we care about, mapped to our normalized types.
const TICKER_TYPES: Array<{ apiType: string; normalizedType: "stock" | "etf" }> = [
	{ apiType: "CS", normalizedType: "stock" },
	{ apiType: "ADRC", normalizedType: "stock" },
	{ apiType: "OS", normalizedType: "stock" },
	{ apiType: "ETF", normalizedType: "etf" },
	{ apiType: "ETN", normalizedType: "etf" },
	{ apiType: "ETV", normalizedType: "etf" },
	{ apiType: "ETS", normalizedType: "etf" },
];

const CONCURRENCY = 20;
const LIST_MAX_RETRIES = 3;
const LIST_BASE_DELAY_MS = 2_000;

interface ListedTicker {
	symbol: string;
	name: string;
	type: "stock" | "etf";
}

interface OutputSymbol {
	symbol: string;
	name: string;
	type: "stock" | "etf";
	icon_url: string | null;
}

interface OutputFile {
	metadata: {
		source: string;
		fetched_at: string;
		type_counts: { stock: number; etf: number };
		total_symbols: number;
		details_fetched: number;
		details_failed: number;
	};
	data: OutputSymbol[];
}

/**
 * Validates that a pagination next_url is safe to use (same host and path prefix).
 * Prevents secret exfiltration if next_url is ever untrusted (e.g. compromised upstream).
 * @throws Error if the URL is invalid or points outside api.massive.com tickers endpoint
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
		throw new Error(
			`Invalid next_url: host must be ${MASSIVE_ALLOWED_HOST} (got ${parsed.host})`,
		);
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

/** Parse Retry-After header (seconds) to milliseconds; returns null if missing/invalid. */
function parseRetryAfterMs(headerValue: string | null): number | null {
	if (!headerValue) return null;
	const seconds = Number(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1_000;
	}
	return null;
}

/**
 * Paginate through the Massive list tickers endpoint for a single type.
 * Follows `next_url` for pagination (validated to prevent secret exfiltration).
 */
async function listTickersForType(
	apiType: string,
	normalizedType: "stock" | "etf",
): Promise<ListedTicker[]> {
	const apiKey = process.env.MASSIVE_API_KEY;
	if (!apiKey) {
		throw new Error(
			"MASSIVE_API_KEY is not set. Add it to .env.local and run with --env-file-if-exists=.env.local",
		);
	}

	const tickers: ListedTicker[] = [];
	const seenPageUrls = new Set<string>();
	let url: string | null =
		`${MASSIVE_BASE_URL}/v3/reference/tickers?market=stocks&active=true&limit=1000&type=${apiType}&apiKey=${apiKey}`;

	while (url) {
		const pageUrl = new URL(url);
		pageUrl.searchParams.delete("apiKey");
		const canonicalPageUrl = pageUrl.toString();
		if (seenPageUrls.has(canonicalPageUrl)) {
			throw new Error(`Repeated ticker pagination URL for type ${apiType}`);
		}
		seenPageUrls.add(canonicalPageUrl);

		let data: Record<string, unknown> | undefined;

		for (let attempt = 1; attempt <= LIST_MAX_RETRIES; attempt++) {
			let response: Response;
			try {
				response = await fetch(url, {
					signal: AbortSignal.timeout(30_000),
				});
			} catch (error) {
				if (attempt === LIST_MAX_RETRIES) throw error;

				const retryDelay = LIST_BASE_DELAY_MS * 2 ** (attempt - 1);
				console.warn(
					`  Retrying list for ${apiType} (attempt ${attempt}/${LIST_MAX_RETRIES}, ${error instanceof Error ? error.message : String(error)}, waiting ${retryDelay}ms)`,
				);
				await delay(retryDelay);
				continue;
			}

			if (response.ok) {
				data = (await response.json()) as Record<string, unknown>;
				break;
			}

			const isRetryable = response.status === 429 || response.status >= 500;
			if (!isRetryable || attempt === LIST_MAX_RETRIES) {
				throw new Error(
					`Failed to list tickers for type ${apiType}: HTTP ${response.status}`,
				);
			}

			const retryAfterMs =
				response.status === 429
					? parseRetryAfterMs(response.headers.get("Retry-After"))
					: null;
			const retryDelay =
				retryAfterMs !== null
					? Math.min(retryAfterMs, 60_000)
					: LIST_BASE_DELAY_MS * 2 ** (attempt - 1);
			console.warn(
				`  Retrying list for ${apiType} (attempt ${attempt}/${LIST_MAX_RETRIES}, HTTP ${response.status}, waiting ${retryDelay}ms)`,
			);
			await delay(retryDelay);
		}

		const results = data!.results;

		if (!Array.isArray(results)) {
			throw new Error(
				`Unexpected ticker list payload for type ${apiType}: missing results[]`,
			);
		}
		for (const item of results) {
			if (typeof item !== "object" || item === null) continue;
			const rec = item as Record<string, unknown>;
			const symbol =
				typeof rec.ticker === "string" ? rec.ticker.trim().toUpperCase() : "";
			const name = typeof rec.name === "string" ? rec.name.trim() : "";

			// Skip symbols with dots (e.g., BRK.A) and empty names
			if (!symbol || symbol.includes(".")) continue;
			if (!name) continue;

			tickers.push({ symbol, name, type: normalizedType });
		}

		// Follow pagination (validate next_url to prevent secret exfiltration)
		const nextUrl = data!.next_url;
		if (nextUrl != null && typeof nextUrl !== "string") {
			throw new Error(
				`Unexpected ticker list payload for type ${apiType}: invalid next_url`,
			);
		}
		if (typeof nextUrl === "string" && nextUrl.length > 0) {
			const nextPageUrl = validateNextUrl(nextUrl);
			nextPageUrl.searchParams.set("apiKey", apiKey);
			url = nextPageUrl.toString();
		} else {
			url = null;
		}
	}

	return tickers;
}

/**
 * Pass 1: List all tickers across all types.
 */
async function listAllTickers(): Promise<ListedTicker[]> {
	const allTickers: ListedTicker[] = [];

	for (const { apiType, normalizedType } of TICKER_TYPES) {
		console.info(`  Fetching type ${apiType}...`);
		const tickers = await listTickersForType(apiType, normalizedType);
		console.info(`    ${tickers.length} tickers`);
		allTickers.push(...tickers);
	}

	// Deduplicate by symbol — keep the first occurrence (type ordering follows TICKER_TYPES).
	// If a symbol appears in multiple API types (e.g., listed as both CS and ETF),
	// the first match wins. This is rare in practice.
	const seen = new Map<string, string>();
	const unique: ListedTicker[] = [];
	for (const t of allTickers) {
		const existingType = seen.get(t.symbol);
		if (existingType) {
			console.warn(`  Duplicate symbol ${t.symbol}: keeping type "${existingType}", skipping "${t.type}"`);
			continue;
		}
		seen.set(t.symbol, t.type);
		unique.push(t);
	}

	return unique;
}

/**
 * Fetch details for a single ticker (branding + SIC code).
 */
async function fetchTickerDetails(
	symbol: string,
): Promise<{ ok: boolean; icon_url: string | null }> {
	const data = await marketDataFetch(
		`/v3/reference/tickers/${encodeURIComponent(symbol)}`,
		{},
		"ticker-details",
	);

	if (typeof data !== "object" || data === null) {
		return { ok: false, icon_url: null };
	}

	const results = (data as Record<string, unknown>).results;
	if (typeof results !== "object" || results === null) {
		return { ok: false, icon_url: null };
	}

	const rec = results as Record<string, unknown>;
	const branding = rec.branding;

	let icon_url: string | null = null;
	if (typeof branding === "object" && branding !== null) {
		const url = (branding as Record<string, unknown>).icon_url;
		if (typeof url === "string" && url.trim() !== "") {
			icon_url = url;
		}
	}

	return { ok: true, icon_url };
}

/**
 * Pass 2: Fetch details for all tickers with bounded concurrency.
 */
async function fetchAllDetails(
	tickers: ListedTicker[],
): Promise<{ results: Map<string, { icon_url: string | null }>; failed: number }> {
	const results = new Map<string, { icon_url: string | null }>();
	let failed = 0;
	let completed = 0;

	// Process in batches of CONCURRENCY
	for (let i = 0; i < tickers.length; i += CONCURRENCY) {
		const batch = tickers.slice(i, i + CONCURRENCY);
		const promises = batch.map(async (t) => {
			try {
				const details = await fetchTickerDetails(t.symbol);
				if (!details.ok) failed++;
				results.set(t.symbol, {
					icon_url: details.icon_url,
				});
			} catch {
				results.set(t.symbol, { icon_url: null });
				failed++;
			}
		});

		await Promise.all(promises);
		completed += batch.length;

		if (completed % 500 < CONCURRENCY) {
			console.info(`  Progress: ${completed}/${tickers.length} details fetched`);
		}
	}

	return { results, failed };
}

async function main() {
	console.info("Pass 1: Listing tickers from Massive API...");
	const tickers = await listAllTickers();
	console.info(`  Total unique tickers: ${tickers.length}`);

	console.info("\nPass 2: Fetching ticker details (branding)...");
	const { results: detailsMap, failed } = await fetchAllDetails(tickers);
	if (failed > 0) {
		throw new Error(
			`Failed to fetch details for ${failed} tickers; aborting write to avoid partial enrichment.`,
		);
	}
	console.info(
		`  Detail requests succeeded: ${tickers.length - failed}, failed: ${failed}`,
	);

	// Build output
	const symbols: OutputSymbol[] = tickers.map((t) => {
		const details = detailsMap.get(t.symbol) ?? { icon_url: null };
		return {
			symbol: t.symbol,
			name: t.name,
			type: t.type,
			icon_url: details.icon_url,
		};
	});

	// Sort alphabetically for stable diffs
	symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));

	const stockCount = symbols.filter((s) => s.type === "stock").length;
	const etfCount = symbols.filter((s) => s.type === "etf").length;
	const detailsFetched = symbols.length - failed;

	const output: OutputFile = {
		metadata: {
			source: "Massive API /v3/reference/tickers + /v3/reference/tickers/{symbol}",
			fetched_at: new Date().toISOString(),
			type_counts: { stock: stockCount, etf: etfCount },
			total_symbols: symbols.length,
			details_fetched: detailsFetched,
			details_failed: failed,
		},
		data: symbols,
	};

	fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

	console.info(
		[
			"",
			`Written to ${OUTPUT_FILE}`,
			`  ${stockCount} stocks + ${etfCount} ETFs = ${symbols.length} total`,
			`  Details: ${detailsFetched} succeeded, ${failed} failed`,
		].join("\n"),
	);
}

main().catch((error) => {
	console.error("\nFailed to fetch US assets:", error);
	process.exitCode = 1;
});
