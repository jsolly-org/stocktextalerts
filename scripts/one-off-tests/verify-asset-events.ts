#!/usr/bin/env npx tsx
/**
 * Verify provider data used by Asset Events.
 *
 * Checks:
 * - Finnhub earnings calendar
 * - Massive dividends
 * - Massive splits
 * - Massive IPOs
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-asset-events.ts
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-asset-events.ts --tickers AAPL,MSFT
 */

const MASSIVE_BASE_URL = "https://api.massive.com";
const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

interface CheckResult {
	name: string;
	status: "PASS" | "WARN" | "FAIL";
	message: string;
}

function argValue(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	if (idx === -1) return undefined;
	return process.argv[idx + 1];
}

function parseTickers(raw: string | undefined): Set<string> | null {
	if (!raw) return null;
	const set = new Set(
		raw
			.split(",")
			.map((t) => t.trim().toUpperCase())
			.filter(Boolean),
	);
	return set.size > 0 ? set : null;
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

function filterByTickers<T extends { ticker: string }>(rows: T[], tickers: Set<string> | null): T[] {
	if (!tickers) return rows;
	return rows.filter((r) => tickers.has(r.ticker));
}

async function checkEarnings(
	finnhubKey: string,
	tickers: Set<string> | null,
	from: string,
	to: string,
): Promise<CheckResult> {
	const url = `${FINNHUB_BASE_URL}/calendar/earnings?from=${from}&to=${to}&token=${finnhubKey}`;
	const { ok, status, data } = await getJson(url);
	if (!ok) return { name: "finnhub:earnings", status: "FAIL", message: `HTTP ${status}` };
	if (typeof data !== "object" || data === null) {
		return { name: "finnhub:earnings", status: "FAIL", message: "Invalid payload" };
	}
	const calendar = (data as Record<string, unknown>).earningsCalendar;
	if (!Array.isArray(calendar)) {
		return { name: "finnhub:earnings", status: "FAIL", message: "Missing earningsCalendar[]" };
	}
	const rows = calendar
		.filter(
			(item): item is Record<string, unknown> =>
				typeof item === "object" && item !== null && typeof item.symbol === "string",
		)
		.map((item) => ({ ticker: String(item.symbol) }));
	const filtered = filterByTickers(rows, tickers);
	if (filtered.length === 0) {
		return { name: "finnhub:earnings", status: "WARN", message: `0 events for ${from}..${to}` };
	}
	return { name: "finnhub:earnings", status: "PASS", message: `${filtered.length} events` };
}

async function checkMassiveEndpoint(options: {
	name: string;
	path: string;
	apiKey: string;
	params: Record<string, string>;
	tickers: Set<string> | null;
	dateField?: string;
}): Promise<CheckResult> {
	const qs = new URLSearchParams({ ...options.params, apiKey: options.apiKey });
	const url = `${MASSIVE_BASE_URL}${options.path}?${qs.toString()}`;
	const { ok, status, data } = await getJson(url);
	if (!ok) return { name: options.name, status: "FAIL", message: `HTTP ${status}` };
	if (typeof data !== "object" || data === null) {
		return { name: options.name, status: "FAIL", message: "Invalid payload" };
	}
	const results = (data as Record<string, unknown>).results;
	if (!Array.isArray(results)) {
		return { name: options.name, status: "FAIL", message: "Missing results[]" };
	}
	const rows = results
		.filter(
			(item): item is Record<string, unknown> =>
				typeof item === "object" && item !== null && typeof item.ticker === "string",
		)
		.map((item) => ({ ticker: String(item.ticker), date: options.dateField ? item[options.dateField] : null }));
	const filtered = filterByTickers(rows, options.tickers);
	if (filtered.length === 0) {
		return {
			name: options.name,
			status: "WARN",
			message: `0 events${options.tickers ? " for requested tickers" : ""}`,
		};
	}
	return { name: options.name, status: "PASS", message: `${filtered.length} events` };
}

function printResult(result: CheckResult): void {
	const icon = result.status === "PASS" ? "PASS" : result.status === "WARN" ? "WARN" : "FAIL";
	console.log(`${icon.padEnd(4)} ${result.name.padEnd(20)} ${result.message}`);
}

async function main(): Promise<void> {
	const massiveKey = process.env.MASSIVE_API_KEY;
	const finnhubKey = process.env.FINNHUB_API_KEY;
	if (!massiveKey) throw new Error("Missing MASSIVE_API_KEY");
	if (!finnhubKey) throw new Error("Missing FINNHUB_API_KEY");

	const tickers = parseTickers(argValue("--tickers"));
	const from = dateStr(0);
	const to = dateStr(7);

	console.log("Asset Events verifier");
	console.log(`Window: ${from}..${to}`);
	if (tickers) console.log(`Tickers: ${Array.from(tickers).join(", ")}`);
	console.log("");

	const results = await Promise.all([
		checkEarnings(finnhubKey, tickers, from, to),
		checkMassiveEndpoint({
			name: "massive:dividends",
			path: "/v3/reference/dividends",
			apiKey: massiveKey,
			params: {
				"ex_dividend_date.gte": from,
				"ex_dividend_date.lte": to,
				limit: "1000",
			},
			tickers,
			dateField: "ex_dividend_date",
		}),
		checkMassiveEndpoint({
			name: "massive:splits",
			path: "/v3/reference/splits",
			apiKey: massiveKey,
			params: {
				"execution_date.gte": from,
				"execution_date.lte": to,
				limit: "1000",
			},
			tickers,
			dateField: "execution_date",
		}),
		checkMassiveEndpoint({
			name: "massive:ipos",
			path: "/vX/reference/ipos",
			apiKey: massiveKey,
			params: {
				"listing_date.gte": from,
				"listing_date.lte": to,
				limit: "1000",
			},
			tickers,
			dateField: "listing_date",
		}),
	]);

	for (const result of results) printResult(result);

	const failed = results.some((r) => r.status === "FAIL");
	if (failed) process.exitCode = 1;
}

main().catch((error) => {
	console.error("verify-asset-events failed:", error);
	process.exitCode = 1;
});
