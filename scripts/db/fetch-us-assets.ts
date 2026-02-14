/**
 * Fetch all US assets (stocks, ETFs, REITs, ADRs, etc.) from Finnhub and write
 * to scripts/data/us-assets.json.
 *
 * Source: Finnhub /stock/symbol?exchange=US
 * Docs:   https://finnhub.io/docs/api/stock-symbols
 *
 * Finnhub returns objects like:
 *   { currency, description, displaySymbol, figi, isin, mic, shareClassFIGI, symbol, symbol2, type }
 *
 * We normalize Finnhub's `type` values to our own: "stock" or "etf".
 *
 * Included as "stock": Common Stock, ADR, REIT, GDR, MLP, Ltd Part, NY Reg Shrs,
 *   Foreign Sh., Royalty Trst, Tracking Stk, PUBLIC
 * Included as "etf": ETP, Closed-End Fund
 * Excluded: Equity WRT, Unit, Right, Preference, Open-End Fund, PRIVATE, Misc.,
 *   Receipt, CDI, NVDR, SDR, Dutch Cert, Canadian DR, Savings Share,
 *   Stapled Security, empty type
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "..", "data", "us-assets.json");

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

// Finnhub `type` values we include, mapped to our normalized types.
// Stock-like securities: get all notification types (price, daily digest, asset events).
// ETF-like securities: get price notifications only.
const FINNHUB_TYPE_MAP: Record<string, "stock" | "etf"> = {
	"Common Stock": "stock",
	ADR: "stock",
	REIT: "stock",
	GDR: "stock",
	MLP: "stock",
	"Ltd Part": "stock",
	"NY Reg Shrs": "stock",
	"Foreign Sh.": "stock",
	"Royalty Trst": "stock",
	"Tracking Stk": "stock",
	PUBLIC: "stock",
	ETP: "etf",
	"Closed-End Fund": "etf",
};

interface FinnhubSymbol {
	symbol: string;
	description: string;
	type: string;
	// Fields we don't use but Finnhub returns:
	// currency, displaySymbol, figi, isin, mic, shareClassFIGI, symbol2
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

async function fetchSymbols(): Promise<FinnhubSymbol[]> {
	const apiKey = process.env.FINNHUB_API_KEY;
	if (!apiKey) {
		throw new Error(
			"FINNHUB_API_KEY is not set. Add it to .env.local and run with --env-file-if-exists=.env.local",
		);
	}

	const params = new URLSearchParams({ exchange: "US", token: apiKey });
	const url = `${FINNHUB_BASE_URL}/stock/symbol?${params.toString()}`;

	console.info("Fetching US assets from Finnhub...");
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(
			`Finnhub API returned ${response.status}: ${await response.text()}`,
		);
	}

	const data: unknown = await response.json();
	if (!Array.isArray(data)) {
		throw new Error(
			`Expected array from Finnhub, got ${typeof data}`,
		);
	}

	return data as FinnhubSymbol[];
}

function transformSymbols(raw: FinnhubSymbol[]): OutputSymbol[] {
	const symbols: OutputSymbol[] = [];

	for (const item of raw) {
		const normalizedType = FINNHUB_TYPE_MAP[item.type];
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

async function main() {
	const raw = await fetchSymbols();
	console.info(`  Received ${raw.length} raw symbols from Finnhub`);

	// Log all unique Finnhub type values for visibility
	const typeCounts = new Map<string, number>();
	for (const item of raw) {
		typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
	}
	console.info("  Finnhub type breakdown:");
	for (const [type, count] of [...typeCounts.entries()].sort()) {
		const kept = type in FINNHUB_TYPE_MAP ? "KEPT" : "skipped";
		console.info(`    ${type}: ${count} (${kept})`);
	}

	const symbols = transformSymbols(raw);

	const stockTypeCount = symbols.filter((s) => s.type === "stock").length;
	const etfCount = symbols.filter((s) => s.type === "etf").length;

	const output: OutputFile = {
		metadata: {
			source: "https://finnhub.io/api/v1/stock/symbol?exchange=US",
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
