/**
 * Fetch all US assets (stocks, ETFs) via Finnhub and write
 * to scripts/data/us-assets.json.
 *
 * Uses `finnhubFetch` from `src/lib/providers/finnhub.ts` which wraps
 * the Finnhub `/stock/symbol?exchange=US` endpoint with retries, rate-limit
 * handling, and timeouts.
 *
 * We normalize Finnhub's `type` values to our own: "stock" or "etf".
 *
 * Included as "stock": Common Stock, ADR
 * Included as "etf": ETP, ETF, ETN
 * Excluded: all other types (mutual funds, warrants, rights, units, indexes, etc.)
 *
 * Output format (scripts/data/us-assets.json):
 *   {
 *     metadata: { source, fetched_at, type_counts: { stock, etf }, total_symbols },
 *     data: [{ symbol, name, type }]    // sorted alphabetically by symbol
 *   }
 *
 * Requires FINNHUB_API_KEY in .env.local (loaded via --env-file-if-exists).
 *
 * Usage:
 *   npx tsx scripts/db/fetch-us-assets.ts
 *   # or via package.json script:
 *   npm run db:fetch-assets
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finnhubFetch } from "../../src/lib/providers/finnhub";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "..", "data", "us-assets.json");

// Finnhub `type` values we include, mapped to our normalized types.
const ASSET_TYPE_MAP: Record<string, "stock" | "etf"> = {
	"Common Stock": "stock",
	ADR: "stock",
	ETP: "etf",
	ETF: "etf",
	ETN: "etf",
};

interface FinnhubSymbol {
	// Finnhub returns both `symbol` and `displaySymbol`; `symbol` is the canonical ticker.
	symbol: string;
	description: string;
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

/** Fetch all symbols via Finnhub. */
async function fetchAllSymbols(): Promise<FinnhubSymbol[]> {
	// Verify API key is available (finnhubFetch returns null silently when missing)
	if (!process.env.FINNHUB_API_KEY) {
		throw new Error(
			"FINNHUB_API_KEY is not set. Add it to .env.local and run with --env-file-if-exists=.env.local",
		);
	}

	console.info("Fetching US assets via Finnhub...");

	const data = await finnhubFetch(
		"/stock/symbol",
		{ exchange: "US" },
		"fetch-us-assets",
	);
	if (!Array.isArray(data)) {
		throw new Error("Failed to fetch symbols from Finnhub (expected array)");
	}

	const symbols: FinnhubSymbol[] = [];
	for (const item of data) {
		if (
			typeof item === "object" &&
			item !== null &&
			typeof (item as Record<string, unknown>).symbol === "string" &&
			typeof (item as Record<string, unknown>).description === "string" &&
			typeof (item as Record<string, unknown>).type === "string"
		) {
			symbols.push(item as FinnhubSymbol);
		}
	}

	return symbols;
}

/** Normalize Finnhub symbols into our `{symbol,name,type}` set. */
function transformSymbols(raw: FinnhubSymbol[]): OutputSymbol[] {
	const symbols: OutputSymbol[] = [];

	for (const item of raw) {
		const normalizedType = ASSET_TYPE_MAP[item.type];
		if (!normalizedType) continue;

		const symbol = (item.symbol ?? "").trim().toUpperCase();
		const name = (item.description ?? "").trim();

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
	const raw = await fetchAllSymbols();
	console.info(`  Received ${raw.length} raw symbols from Finnhub`);

	// Log all unique Finnhub type values for visibility
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
				"https://finnhub.io/api/v1/stock/symbol?exchange=US",
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
