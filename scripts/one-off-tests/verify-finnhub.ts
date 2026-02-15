#!/usr/bin/env npx tsx
/**
 * Verify Finnhub API endpoints that remain on Finnhub (not migrated to MASSIVE).
 *
 * Endpoints tested:
 *   1. /stock/recommendation — analyst consensus (buy/hold/sell)
 *   2. /stock/insider-transactions — recent insider trades
 *   3. /calendar/earnings   — earnings calendar for a date range
 *
 * Migrated to MASSIVE (see verify-massive.ts):
 *   - /company-news        → /v2/reference/news
 *   - /stock/market-status  → /v1/marketstatus/now
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-finnhub.ts
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-finnhub.ts --tickers AAPL,MSFT
 */

const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const DEFAULT_TICKERS = ["AAPL", "MSFT", "GOOG"];
const REQUEST_TIMEOUT_MS = 15_000;

// ── Helpers ──────────────────────────────────────────────────────────

/** Return the value following a CLI flag (e.g. `--tickers AAPL`). */
function getArgValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

/** Parse `--tickers` into an uppercase ticker list (or defaults). */
function parseTickers(raw: string | undefined): string[] {
	if (!raw) return DEFAULT_TICKERS;
	return raw
		.split(",")
		.map((t) => t.trim().toUpperCase())
		.filter(Boolean);
}

/** Minimal Finnhub GET helper with timeout. */
async function finnhubGet(
	endpoint: string,
	params: Record<string, string>,
	apiKey: string,
): Promise<{ status: number; data: unknown }> {
	const query = new URLSearchParams({ ...params, token: apiKey });
	const url = `${FINNHUB_BASE_URL}${endpoint}?${query.toString()}`;
	const response = await fetch(url, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const data = await response.json();
	return { status: response.status, data };
}

/** Format an ISO date for N days ago. */
function dateStr(daysAgo: number): string {
	const d = new Date();
	d.setDate(d.getDate() - daysAgo);
	return d.toISOString().slice(0, 10);
}

/** Format an ISO date for N days in the future. */
function futureDate(daysAhead: number): string {
	const d = new Date();
	d.setDate(d.getDate() + daysAhead);
	return d.toISOString().slice(0, 10);
}

// ── Individual endpoint tests ────────────────────────────────────────

interface TestResult {
	endpoint: string;
	status: "PASS" | "FAIL" | "WARN";
	message: string;
	detail?: string;
}

/** Verify `/stock/recommendation` returns expected fields. */
async function testRecommendation(
	ticker: string,
	apiKey: string,
): Promise<TestResult> {
	const endpoint = `/stock/recommendation`;
	try {
		const { status, data } = await finnhubGet(
			endpoint,
			{ symbol: ticker },
			apiKey,
		);
		if (status !== 200)
			return { endpoint, status: "FAIL", message: `HTTP ${status}` };
		if (!Array.isArray(data))
			return {
				endpoint,
				status: "FAIL",
				message: `Expected array, got ${typeof data}`,
			};
		if (data.length === 0)
			return {
				endpoint,
				status: "WARN",
				message: `${ticker}: no recommendation data`,
			};

		const latest = data[0] as Record<string, unknown>;
		const requiredFields = [
			"buy",
			"hold",
			"sell",
			"strongBuy",
			"strongSell",
			"period",
		];
		const missing = requiredFields.filter(
			(f) => latest[f] === undefined || latest[f] === null,
		);
		if (missing.length > 0)
			return {
				endpoint,
				status: "FAIL",
				message: `Missing fields: ${missing.join(", ")}`,
				detail: JSON.stringify(latest),
			};

		return {
			endpoint,
			status: "PASS",
			message: `${ticker}: ${latest.strongBuy} Strong Buy, ${latest.buy} Buy, ${latest.hold} Hold, ${latest.sell} Sell, ${latest.strongSell} Strong Sell (${latest.period})`,
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify `/stock/insider-transactions` returns a usable payload. */
async function testInsiderTransactions(
	ticker: string,
	apiKey: string,
): Promise<TestResult> {
	const endpoint = `/stock/insider-transactions`;
	try {
		const { status, data } = await finnhubGet(
			endpoint,
			{ symbol: ticker },
			apiKey,
		);
		if (status !== 200)
			return { endpoint, status: "FAIL", message: `HTTP ${status}` };
		if (typeof data !== "object" || data === null)
			return {
				endpoint,
				status: "FAIL",
				message: `Expected object, got ${typeof data}`,
			};

		const transactions = (data as Record<string, unknown>).data;
		if (!Array.isArray(transactions))
			return {
				endpoint,
				status: "FAIL",
				message: `Expected .data array`,
				detail: JSON.stringify(Object.keys(data as object)),
			};
		if (transactions.length === 0)
			return {
				endpoint,
				status: "WARN",
				message: `${ticker}: 0 insider transactions (may be normal)`,
			};

		const sample = transactions[0] as Record<string, unknown>;
		const hasFields =
			typeof sample.name === "string" && typeof sample.change === "number";
		if (!hasFields)
			return {
				endpoint,
				status: "FAIL",
				message: `Missing expected fields (name, change)`,
				detail: JSON.stringify(Object.keys(sample)),
			};

		const action = (sample.change as number) > 0 ? "bought" : "sold";
		return {
			endpoint,
			status: "PASS",
			message: `${ticker}: ${transactions.length} transactions`,
			detail: `Latest: ${sample.name} ${action} ${Math.abs(sample.change as number).toLocaleString()} shares on ${sample.transactionDate}`,
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify `/calendar/earnings` returns a calendar payload for a date range. */
async function testEarningsCalendar(apiKey: string): Promise<TestResult> {
	const endpoint = `/calendar/earnings`;
	const from = dateStr(0);
	const to = futureDate(7);
	try {
		const { status, data } = await finnhubGet(
			endpoint,
			{ from, to },
			apiKey,
		);
		if (status !== 200)
			return { endpoint, status: "FAIL", message: `HTTP ${status}` };
		if (typeof data !== "object" || data === null)
			return {
				endpoint,
				status: "FAIL",
				message: `Expected object, got ${typeof data}`,
			};

		const calendar = (data as Record<string, unknown>).earningsCalendar;
		if (!Array.isArray(calendar))
			return {
				endpoint,
				status: "FAIL",
				message: `Expected .earningsCalendar array`,
				detail: JSON.stringify(Object.keys(data as object)),
			};
		if (calendar.length === 0)
			return {
				endpoint,
				status: "WARN",
				message: `0 earnings events for ${from} to ${to}`,
			};

		const sample = calendar[0] as Record<string, unknown>;
		const hasFields =
			typeof sample.symbol === "string" && typeof sample.date === "string";
		if (!hasFields)
			return {
				endpoint,
				status: "FAIL",
				message: `Missing expected fields (symbol, date)`,
				detail: JSON.stringify(Object.keys(sample)),
			};

		return {
			endpoint,
			status: "PASS",
			message: `${calendar.length} earnings events from ${from} to ${to}`,
			detail: `Sample: ${sample.symbol} on ${sample.date}, EPS est: ${sample.epsEstimate ?? "N/A"}`,
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

// ── Main ─────────────────────────────────────────────────────────────

/** Print one test result line (plus optional details). */
function printResult(result: TestResult) {
	const icon =
		result.status === "PASS"
			? "\x1b[32mPASS\x1b[0m"
			: result.status === "WARN"
				? "\x1b[33mWARN\x1b[0m"
				: "\x1b[31mFAIL\x1b[0m";
	console.log(`  [${icon}] ${result.endpoint} — ${result.message}`);
	if (result.detail) {
		console.log(`         ${result.detail}`);
	}
}

/** Script entrypoint: run endpoint checks and exit non-zero on failures. */
async function main() {
	const args = process.argv.slice(2);
	const apiKey = process.env.FINNHUB_API_KEY;
	if (!apiKey) {
		console.error("Missing FINNHUB_API_KEY in environment.");
		console.error(
			"Run with: node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-finnhub.ts",
		);
		process.exitCode = 2;
		return;
	}

	const tickers = parseTickers(getArgValue(args, "--tickers"));
	console.log(`\nFinnhub API Verification`);
	console.log(`========================`);
	console.log(`Tickers: ${tickers.join(", ")}\n`);

	const results: TestResult[] = [];

	// Global endpoints (not ticker-specific)
	console.log("Global endpoints:");
	const earnings = await testEarningsCalendar(apiKey);
	results.push(earnings);
	printResult(earnings);

	// Per-ticker endpoints
	for (const ticker of tickers) {
		console.log(`\n${ticker}:`);
		// Run in parallel per ticker
		const [reco, insider] = await Promise.all([
			testRecommendation(ticker, apiKey),
			testInsiderTransactions(ticker, apiKey),
		]);
		results.push(reco, insider);
		printResult(reco);
		printResult(insider);
	}

	// Summary
	const passed = results.filter((r) => r.status === "PASS").length;
	const warned = results.filter((r) => r.status === "WARN").length;
	const failed = results.filter((r) => r.status === "FAIL").length;

	console.log(`\n────────────────────────────────────────`);
	console.log(
		`Results: ${passed} passed, ${warned} warnings, ${failed} failed (${results.length} total)`,
	);

	if (failed > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error("verify-finnhub failed:", error);
	process.exitCode = 1;
});
