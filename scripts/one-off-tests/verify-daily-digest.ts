#!/usr/bin/env npx tsx
/**
 * Verify data dependencies used by Daily Digest.
 *
 * Checks:
 * - Massive batch snapshot quotes for tracked tickers
 * - Finnhub company news (optional section source)
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-daily-digest.ts --tickers AAPL,MSFT,TSLA
 */

const MASSIVE_BASE_URL = "https://api.polygon.io";
const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

function argValue(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	if (idx === -1) return undefined;
	return process.argv[idx + 1];
}

function parseTickers(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((t) => t.trim().toUpperCase())
		.filter(Boolean);
}

function dateStr(daysFromToday: number): string {
	const d = new Date();
	d.setDate(d.getDate() + daysFromToday);
	return d.toISOString().slice(0, 10);
}

async function getJson(url: string): Promise<{ ok: boolean; status: number; data: unknown }> {
	const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		data = null;
	}
	return { ok: res.ok, status: res.status, data };
}

async function main(): Promise<void> {
	const massiveKey = process.env.MASSIVE_API_KEY;
	const finnhubKey = process.env.FINNHUB_API_KEY;
	if (!massiveKey) throw new Error("Missing MASSIVE_API_KEY");
	if (!finnhubKey) throw new Error("Missing FINNHUB_API_KEY");

	const tickers = parseTickers(argValue("--tickers"));
	if (tickers.length === 0) {
		throw new Error("Missing required --tickers <csv>");
	}

	console.log("Daily Digest verifier");
	console.log(`Tickers: ${tickers.join(", ")}`);
	console.log("");

	const quoteQs = new URLSearchParams({
		tickers: tickers.join(","),
		apiKey: massiveKey,
	});
	const quoteUrl = `${MASSIVE_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers?${quoteQs.toString()}`;
	const quoteResp = await getJson(quoteUrl);
	if (!quoteResp.ok) throw new Error(`snapshot failed: HTTP ${quoteResp.status}`);
	if (typeof quoteResp.data !== "object" || quoteResp.data === null) throw new Error("snapshot payload invalid");
	const rawTickers = (quoteResp.data as Record<string, unknown>).tickers;
	if (!Array.isArray(rawTickers)) throw new Error("snapshot payload missing tickers[]");

	const bySymbol = new Map<string, Record<string, unknown>>();
	for (const row of rawTickers) {
		if (typeof row !== "object" || row === null) continue;
		const ticker = (row as Record<string, unknown>).ticker;
		if (typeof ticker !== "string") continue;
		bySymbol.set(ticker, row as Record<string, unknown>);
	}

	let quoteFailures = 0;
	for (const ticker of tickers) {
		const row = bySymbol.get(ticker);
		if (!row) {
			quoteFailures++;
			console.log(`FAIL quotes:${ticker} missing from snapshot response`);
			continue;
		}
		const day = row.day as Record<string, unknown> | undefined;
		const price = day?.c;
		const change = row.todaysChangePerc;
		if (typeof price !== "number" || !Number.isFinite(price) || typeof change !== "number" || !Number.isFinite(change)) {
			quoteFailures++;
			console.log(`FAIL quotes:${ticker} missing price/change fields`);
			continue;
		}
		const sign = change >= 0 ? "+" : "";
		console.log(`PASS quotes:${ticker} $${price.toFixed(2)} (${sign}${change.toFixed(2)}%)`);
	}

	console.log("");
	const from = dateStr(-3);
	const to = dateStr(0);
	for (const ticker of tickers.slice(0, 3)) {
		const newsUrl = `${FINNHUB_BASE_URL}/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${finnhubKey}`;
		const newsResp = await getJson(newsUrl);
		if (!newsResp.ok) {
			console.log(`FAIL news:${ticker} HTTP ${newsResp.status}`);
			quoteFailures++;
			continue;
		}
		if (!Array.isArray(newsResp.data)) {
			console.log(`FAIL news:${ticker} payload is not array`);
			quoteFailures++;
			continue;
		}
		console.log(`PASS news:${ticker} ${newsResp.data.length} articles (${from}..${to})`);
	}

	if (quoteFailures > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error("verify-daily-digest failed:", error);
	process.exitCode = 1;
});
