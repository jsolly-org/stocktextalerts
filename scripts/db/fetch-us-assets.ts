/**
 * Fetch all US assets (stocks, ETFs) via the Massive provider and write
 * to scripts/data/us-assets.json.
 *
 * Uses `marketDataFetch` from `src/lib/providers/massive.ts` which wraps
 * the Massive `/v3/reference/tickers?market=stocks&active=true&limit=1000` endpoint
 * with retries, rate-limit handling, and timeouts.
 *
 * We normalize Massive's `type` values to our own: "stock" or "etf".
 *
 * Included as "stock": CS (Common Stock), ADRC (ADR)
 * Included as "etf": ETF, ETN
 * Excluded: all other types (WARRANT, RIGHT, UNIT, FUND, OS, GDR, SP, etc.)
 *
 * Output format (scripts/data/us-assets.json):
 *   {
 *     metadata: { source, fetched_at, type_counts: { stock, etf }, total_symbols },
 *     data: [{ symbol, name, type }]    // sorted alphabetically by symbol
 *   }
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "..", "data", "us-assets.json");

// Massive `type` values we include, mapped to our normalized types.
const ASSET_TYPE_MAP: Record<string, "stock" | "etf"> = {
	CS: "stock",
	ADRC: "stock",
	ETF: "etf",
	ETN: "etf",
};

interface MassiveTicker {
	ticker: string;
	name: string;
	type: string;
}

interface OutputSymbol {
	symbol: string;
	name: string;
	type: "stock" | "etf";
}

interface OutputFile {
	metadata: {
		source: string;
		fetched_at: string;
		type_counts: { stock: number; etf: number };
		total_symbols: number;
	};
	data: OutputSymbol[];
}

/** Fetch all tickers via Massive provider with pagination. */
async function fetchAllTickers(): Promise<MassiveTicker[]> {
	// Verify API key is available (marketDataFetch returns null silently when missing)
	if (!process.env.MASSIVE_API_KEY) {
		throw new Error(
			"MASSIVE_API_KEY is not set. Add it to .env.local and run with --env-file-if-exists=.env.local",
		);
	}

	const allTickers: MassiveTicker[] = [];
	let cursor: string | null = null;
	let page = 1;

	console.info("Fetching US assets via Massive...");

	while (true) {
		console.info(`  Fetching page ${page}...`);

		const params: Record<string, string> = {
			market: "stocks",
			active: "true",
			limit: "1000",
		};
		if (cursor) params.cursor = cursor;

		const data = await marketDataFetch(
			"/v3/reference/tickers",
			params,
			"fetch-us-assets",
		);

		if (typeof data !== "object" || data === null) {
			if (page === 1) {
				throw new Error("Failed to fetch tickers from Massive");
			}
			break;
		}

		const record = data as Record<string, unknown>;
		const results = record.results;
		if (!Array.isArray(results)) {
			throw new Error(
				`Expected .results array from Massive, got ${typeof results}`,
			);
		}

		// Defensive: validate each ticker object before casting.
		for (const item of results) {
			if (
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).ticker === "string" &&
				typeof (item as Record<string, unknown>).name === "string" &&
				typeof (item as Record<string, unknown>).type === "string"
			) {
				allTickers.push(item as MassiveTicker);
			}
		}

		// Extract cursor for next page from next_url
		const nextUrl =
			typeof record.next_url === "string" ? record.next_url : null;
		if (!nextUrl) break;

		try {
			const url = new URL(nextUrl);
			cursor = url.searchParams.get("cursor");
			if (!cursor) break;
		} catch {
			break;
		}

		page++;
	}

	return allTickers;
}

/** Normalize Massive tickers into our `{symbol,name,type}` set. */
function transformSymbols(raw: MassiveTicker[]): OutputSymbol[] {
	const symbols: OutputSymbol[] = [];

	for (const item of raw) {
		const normalizedType = ASSET_TYPE_MAP[item.type];
		if (!normalizedType) continue;

		const symbol = (item.ticker ?? "").trim().toUpperCase();
		const name = (item.name ?? "").trim();

		// Skip symbols with dots (preferred shares like BRK.A) or empty symbols
		if (!symbol || symbol.includes(".")) continue;
		if (!name) continue;

		symbols.push({ symbol, name, type: normalizedType });
	}

	// Sort alphabetically for stable diffs
	symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));

	return symbols;
}

/** Script entrypoint: fetch, normalize, and write `scripts/data/us-assets.json`. */
async function main() {
	const raw = await fetchAllTickers();
	console.info(`  Received ${raw.length} raw tickers from Massive`);

	// Log all unique Massive type values for visibility
	const typeCounts = new Map<string, number>();
	for (const item of raw) {
		typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
	}
	console.info("  Type breakdown:");
	for (const [type, count] of [...typeCounts.entries()].sort()) {
		const kept = type in ASSET_TYPE_MAP ? "KEPT" : "skipped";
		console.info(`    ${type}: ${count} (${kept})`);
	}

	const symbols = transformSymbols(raw);

	const stockTypeCount = symbols.filter((s) => s.type === "stock").length;
	const etfCount = symbols.filter((s) => s.type === "etf").length;

	const output: OutputFile = {
		metadata: {
			source:
				"massive:/v3/reference/tickers?market=stocks&active=true",
			fetched_at: new Date().toISOString(),
			type_counts: { stock: stockTypeCount, etf: etfCount },
			total_symbols: symbols.length,
		},
		data: symbols,
	};

	fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`);

	console.info(
		[
			"",
			`Written to ${OUTPUT_FILE}`,
			`  ${stockTypeCount} stocks + ${etfCount} ETFs = ${symbols.length} total`,
		].join("\n"),
	);
}

main().catch((error) => {
	console.error("\nFailed to fetch US assets:", error);
	process.exitCode = 1;
});
