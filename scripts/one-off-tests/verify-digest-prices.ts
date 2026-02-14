#!/usr/bin/env npx tsx
/**
 * Verify Daily Digest quote fetch behavior for a ticker set using direct Massive API calls.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-digest-prices.ts --tickers GOOG,META,TSLA
 */

interface SnapshotQuote {
	price: number;
	changePercent: number;
}

const MASSIVE_BASE_URL = "https://api.polygon.io";

function getArgValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function parseTickers(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((ticker) => ticker.trim().toUpperCase())
		.filter(Boolean);
}

function usage(): string {
	return [
		"Usage:",
		"  node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-digest-prices.ts --tickers GOOG,META,TSLA",
		"",
		"Options:",
		"  --tickers <csv>   Required comma-separated ticker list",
	].join("\n");
}

function formatQuoteLine(
	ticker: string,
	quote: SnapshotQuote | null | undefined,
): string {
	if (!quote) return `${ticker}: null`;
	const sign = quote.changePercent >= 0 ? "+" : "";
	return `${ticker}: $${quote.price.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`;
}

function parseSnapshotTicker(
	raw: unknown,
): { ticker: string; quote: SnapshotQuote | null } | null {
	if (typeof raw !== "object" || raw === null) return null;
	const item = raw as {
		ticker?: unknown;
		todaysChangePerc?: unknown;
		day?: { c?: unknown };
	};

	if (typeof item.ticker !== "string") return null;

	const price = item.day?.c;
	const changePercent = item.todaysChangePerc;

	if (
		typeof price !== "number" ||
		!Number.isFinite(price) ||
		price === 0 ||
		typeof changePercent !== "number" ||
		!Number.isFinite(changePercent)
	) {
		return { ticker: item.ticker, quote: null };
	}

	return {
		ticker: item.ticker,
		quote: { price, changePercent },
	};
}

async function fetchSnapshotQuotes(
	tickers: string[],
	apiKey: string,
): Promise<Map<string, SnapshotQuote | null>> {
	const result = new Map<string, SnapshotQuote | null>();
	for (const ticker of tickers) {
		result.set(ticker, null);
	}

	if (tickers.length === 0) return result;

	const params = new URLSearchParams({
		tickers: tickers.join(","),
		apiKey,
	});
	const url = `${MASSIVE_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers?${params.toString()}`;

	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		throw new Error(
			`Massive snapshot failed: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as { tickers?: unknown };
	if (!Array.isArray(data.tickers)) {
		return result;
	}

	for (const raw of data.tickers) {
		const parsed = parseSnapshotTicker(raw);
		if (!parsed) continue;
		result.set(parsed.ticker, parsed.quote);
	}

	return result;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(usage());
		return;
	}

	const apiKey = process.env.MASSIVE_API_KEY;
	if (!apiKey) {
		console.error(
			"Missing MASSIVE_API_KEY in environment.",
		);
		process.exitCode = 2;
		return;
	}

	const tickers = parseTickers(getArgValue(args, "--tickers"));
	if (tickers.length === 0) {
		console.error("Missing required arg: --tickers");
		console.error(usage());
		process.exitCode = 2;
		return;
	}

	console.log(`Tickers (${tickers.length}): ${tickers.join(", ")}`);

	const batchSnapshot = await fetchSnapshotQuotes(tickers, apiKey);

	console.log("\nBatch snapshot call:");
	for (const ticker of tickers) {
		console.log(`  ${formatQuoteLine(ticker, batchSnapshot.get(ticker))}`);
	}

	const batchNonNull = tickers.filter(
		(ticker) => batchSnapshot.get(ticker) !== null,
	);
	console.log(
		`Batch non-null quotes: ${batchNonNull.length}/${tickers.length}`,
	);

	console.log("\nPer-symbol snapshot calls:");
	let perSymbolNonNullCount = 0;
	for (const ticker of tickers) {
		const single = await fetchSnapshotQuotes([ticker], apiKey);
		const quote = single.get(ticker);
		if (quote) perSymbolNonNullCount++;
		console.log(`  ${formatQuoteLine(ticker, quote)}`);
	}
	console.log(
		`Per-symbol non-null quotes: ${perSymbolNonNullCount}/${tickers.length}`,
	);

	if (batchNonNull.length === 0 && perSymbolNonNullCount > 0) {
		console.log(
			"\nDiagnosis: batch call returned all null, but per-symbol returned quotes.",
		);
		process.exitCode = 1;
		return;
	}
	if (batchNonNull.length === 0 && perSymbolNonNullCount === 0) {
		console.log(
			"\nDiagnosis: no quotes returned in either mode (API/data issue or unsupported tickers).",
		);
		process.exitCode = 1;
		return;
	}

	console.log("\nDiagnosis: batch response includes quotes.");
}

main().catch((error) => {
	console.error("verify-digest-prices failed:", error);
	process.exitCode = 1;
});
