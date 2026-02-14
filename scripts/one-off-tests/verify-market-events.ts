#!/usr/bin/env npx tsx
/**
 * Verify data dependencies used by market notification pipelines.
 *
 * Checks:
 * - Massive market status
 * - Massive batch snapshot quotes (used by scheduled + alert processing)
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-market-events.ts --tickers AAPL,MSFT,NVDA
 */

const POLYGON_BASE_URL = "https://api.polygon.io";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TICKERS = ["AAPL", "MSFT", "NVDA"];

function argValue(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	if (idx === -1) return undefined;
	return process.argv[idx + 1];
}

function parseTickers(raw: string | undefined): string[] {
	if (!raw) return DEFAULT_TICKERS;
	const parsed = raw
		.split(",")
		.map((t) => t.trim().toUpperCase())
		.filter(Boolean);
	return parsed.length > 0 ? parsed : DEFAULT_TICKERS;
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
	const polygonKey = process.env.POLYGON_API_KEY;
	if (!polygonKey) throw new Error("Missing POLYGON_API_KEY");

	const tickers = parseTickers(argValue("--tickers"));

	console.log("Market Events verifier");
	console.log(`Tickers: ${tickers.join(", ")}`);
	console.log("");

	const statusUrl = `${POLYGON_BASE_URL}/v1/marketstatus/now?apiKey=${polygonKey}`;
	const marketStatus = await getJson(statusUrl);
	if (!marketStatus.ok) throw new Error(`market status failed: HTTP ${marketStatus.status}`);
	if (typeof marketStatus.data !== "object" || marketStatus.data === null) {
		throw new Error("market status payload invalid");
	}
	const market = (marketStatus.data as Record<string, unknown>).market;
	const serverTime = (marketStatus.data as Record<string, unknown>).serverTime;
	console.log(`PASS market-status market=${String(market)} serverTime=${String(serverTime)}`);

	const qs = new URLSearchParams({ tickers: tickers.join(","), apiKey: polygonKey });
	const snapshotUrl = `${POLYGON_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers?${qs.toString()}`;
	const snapshot = await getJson(snapshotUrl);
	if (!snapshot.ok) throw new Error(`snapshot failed: HTTP ${snapshot.status}`);
	if (typeof snapshot.data !== "object" || snapshot.data === null) throw new Error("snapshot payload invalid");
	const rows = (snapshot.data as Record<string, unknown>).tickers;
	if (!Array.isArray(rows)) throw new Error("snapshot payload missing tickers[]");

	const map = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const ticker = (row as Record<string, unknown>).ticker;
		if (typeof ticker === "string") map.set(ticker, row as Record<string, unknown>);
	}

	let failures = 0;
	for (const ticker of tickers) {
		const row = map.get(ticker);
		if (!row) {
			failures++;
			console.log(`FAIL snapshot:${ticker} missing`);
			continue;
		}
		const day = row.day as Record<string, unknown> | undefined;
		const prevDay = row.prevDay as Record<string, unknown> | undefined;
		const price = day?.c;
		const prevClose = prevDay?.c;
		if (typeof price !== "number" || !Number.isFinite(price) || typeof prevClose !== "number" || !Number.isFinite(prevClose)) {
			failures++;
			console.log(`FAIL snapshot:${ticker} missing c/prevDay.c`);
			continue;
		}
		const change = ((price - prevClose) / prevClose) * 100;
		const sign = change >= 0 ? "+" : "";
		console.log(`PASS snapshot:${ticker} $${price.toFixed(2)} (${sign}${change.toFixed(2)}% vs prev close)`);
	}

	if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error("verify-market-events failed:", error);
	process.exitCode = 1;
});
