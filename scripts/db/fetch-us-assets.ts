/**
 * Fetch all US assets (stocks, ETFs) via Massive API and write
 * to scripts/data/us-assets.json.
 *
 * Two-pass approach:
 *   Pass 1 — List tickers: Paginate /v3/reference/tickers for each type.
 *   Pass 2 — Fetch details: For each ticker, call /v3/reference/tickers/{symbol}
 *            to get branding.icon_url and sic_code for sector mapping.
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
import { fileURLToPath } from "node:url";
import { marketDataFetch } from "../../src/lib/providers/massive";
import { sicCodeToSector } from "../../src/lib/providers/sector-mapping";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "..", "data", "us-assets.json");

const MASSIVE_BASE_URL = "https://api.massive.com";

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
	sector: string | null;
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
 * Paginate through the Massive list tickers endpoint for a single type.
 * Follows `next_url` for pagination.
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
	let url: string | null =
		`${MASSIVE_BASE_URL}/v3/reference/tickers?market=stocks&active=true&limit=1000&type=${apiType}&apiKey=${apiKey}`;

	while (url) {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			console.error(`  Failed to list tickers for type ${apiType}: HTTP ${response.status}`);
			break;
		}

		const data = (await response.json()) as Record<string, unknown>;
		const results = data.results;

		if (Array.isArray(results)) {
			for (const item of results) {
				if (typeof item !== "object" || item === null) continue;
				const rec = item as Record<string, unknown>;
				const symbol = typeof rec.ticker === "string" ? rec.ticker.trim().toUpperCase() : "";
				const name = typeof rec.name === "string" ? rec.name.trim() : "";

				// Skip symbols with dots (e.g., BRK.A) and empty names
				if (!symbol || symbol.includes(".")) continue;
				if (!name) continue;

				tickers.push({ symbol, name, type: normalizedType });
			}
		}

		// Follow pagination
		const nextUrl = data.next_url;
		if (typeof nextUrl === "string" && nextUrl.length > 0) {
			// next_url doesn't include the API key
			const separator = nextUrl.includes("?") ? "&" : "?";
			url = `${nextUrl}${separator}apiKey=${apiKey}`;
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

	// Deduplicate by symbol (keep first occurrence)
	const seen = new Set<string>();
	const unique: ListedTicker[] = [];
	for (const t of allTickers) {
		if (seen.has(t.symbol)) continue;
		seen.add(t.symbol);
		unique.push(t);
	}

	return unique;
}

/**
 * Fetch details for a single ticker (branding + SIC code).
 */
async function fetchTickerDetails(
	symbol: string,
): Promise<{ icon_url: string | null; sector: string | null }> {
	const data = await marketDataFetch(
		`/v3/reference/tickers/${encodeURIComponent(symbol)}`,
		{},
		"ticker-details",
	);

	if (typeof data !== "object" || data === null) {
		return { icon_url: null, sector: null };
	}

	const results = (data as Record<string, unknown>).results;
	if (typeof results !== "object" || results === null) {
		return { icon_url: null, sector: null };
	}

	const rec = results as Record<string, unknown>;
	const sicCode = rec.sic_code;
	const branding = rec.branding;

	let icon_url: string | null = null;
	if (typeof branding === "object" && branding !== null) {
		const url = (branding as Record<string, unknown>).icon_url;
		if (typeof url === "string" && url.trim() !== "") {
			icon_url = url;
		}
	}

	let sector: string | null = null;
	if (typeof sicCode === "string" || typeof sicCode === "number") {
		sector = sicCodeToSector(String(sicCode));
	}

	return { icon_url, sector };
}

/**
 * Pass 2: Fetch details for all tickers with bounded concurrency.
 */
async function fetchAllDetails(
	tickers: ListedTicker[],
): Promise<{ results: Map<string, { icon_url: string | null; sector: string | null }>; failed: number }> {
	const results = new Map<string, { icon_url: string | null; sector: string | null }>();
	let failed = 0;
	let completed = 0;

	// Process in batches of CONCURRENCY
	for (let i = 0; i < tickers.length; i += CONCURRENCY) {
		const batch = tickers.slice(i, i + CONCURRENCY);
		const promises = batch.map(async (t) => {
			try {
				const details = await fetchTickerDetails(t.symbol);
				results.set(t.symbol, details);
			} catch {
				results.set(t.symbol, { icon_url: null, sector: null });
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

	console.info("\nPass 2: Fetching ticker details (branding + sector)...");
	const { results: detailsMap, failed } = await fetchAllDetails(tickers);
	console.info(`  Details fetched: ${detailsMap.size}, failed: ${failed}`);

	// Build output
	const symbols: OutputSymbol[] = tickers.map((t) => {
		const details = detailsMap.get(t.symbol) ?? { icon_url: null, sector: null };
		return {
			symbol: t.symbol,
			name: t.name,
			type: t.type,
			icon_url: details.icon_url,
			sector: details.sector,
		};
	});

	// Sort alphabetically for stable diffs
	symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));

	const stockCount = symbols.filter((s) => s.type === "stock").length;
	const etfCount = symbols.filter((s) => s.type === "etf").length;
	const detailsFetched = symbols.filter(
		(s) => s.icon_url !== null || s.sector !== null,
	).length;

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
			`  Details: ${detailsFetched} with data, ${failed} failed`,
		].join("\n"),
	);
}

main().catch((error) => {
	console.error("\nFailed to fetch US assets:", error);
	process.exitCode = 1;
});
