#!/usr/bin/env npx tsx
/**
 * Verify Polygon API endpoints return expected data.
 *
 * Endpoints tested:
 *   1. /v2/snapshot/locale/us/markets/stocks/tickers — batch snapshot quotes
 *   2. /v3/reference/dividends — ex-dividend events for a date range
 *   3. /v3/reference/splits   — stock split events for a date range
 *   4. /v2/reference/news     — company news (migrated from Finnhub)
 *   5. /v1/marketstatus/now   — market open/closed (migrated from Finnhub)
 *   6. /v1/marketstatus/upcoming — market holidays (migrated from Finnhub)
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-massive.ts
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-massive.ts --tickers AAPL,MSFT
 */

const POLYGON_BASE_URL = "https://api.polygon.io";
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

/** Minimal Polygon GET helper with timeout. */
async function polygonGet(
	endpoint: string,
	params: Record<string, string>,
	apiKey: string,
): Promise<{ status: number; data: unknown }> {
	const query = new URLSearchParams({ ...params, apiKey });
	const url = `${POLYGON_BASE_URL}${endpoint}?${query.toString()}`;
	const response = await fetch(url, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const data = await response.json();
	return { status: response.status, data };
}

// ── Individual endpoint tests ────────────────────────────────────────

interface TestResult {
	endpoint: string;
	status: "PASS" | "FAIL" | "WARN";
	message: string;
	detail?: string;
}

/** Verify `/v2/snapshot/.../tickers` returns batch quotes for the given tickers. */
async function testSnapshotQuotes(
	tickers: string[],
	apiKey: string,
): Promise<TestResult> {
	const endpoint = `/v2/snapshot/locale/us/markets/stocks/tickers`;
	try {
		const { status, data } = await polygonGet(
			endpoint,
			{ tickers: tickers.join(",") },
			apiKey,
		);
		if (status !== 200) {
			let apiStatus = "";
			if (typeof data === "object" && data !== null) {
				const s = (data as Record<string, unknown>).status;
				if (typeof s === "string") apiStatus = ` (API status: ${s})`;
			}
			return {
				endpoint,
				status: "FAIL",
				message: `HTTP ${status}${apiStatus}`,
				detail: JSON.stringify(data),
			};
		}

		if (typeof data !== "object" || data === null)
			return {
				endpoint,
				status: "FAIL",
				message: `Expected object, got ${typeof data}`,
			};

		const tickerData = (data as Record<string, unknown>).tickers;
		if (!Array.isArray(tickerData))
			return {
				endpoint,
				status: "FAIL",
				message: `Expected .tickers array`,
				detail: JSON.stringify(Object.keys(data as object)),
			};

		const quoteSummaries: string[] = [];
		let nullCount = 0;

		for (const ticker of tickers) {
			const match = tickerData.find(
				(t: unknown) =>
					typeof t === "object" &&
					t !== null &&
					(t as Record<string, unknown>).ticker === ticker,
			) as Record<string, unknown> | undefined;

			if (!match) {
				quoteSummaries.push(`${ticker}: not in response`);
				nullCount++;
				continue;
			}

			const day = match.day as Record<string, unknown> | undefined;
			const price = day?.c;
			const changePerc = match.todaysChangePerc;

			if (
				typeof price !== "number" ||
				price === 0 ||
				typeof changePerc !== "number"
			) {
				quoteSummaries.push(`${ticker}: missing price data`);
				nullCount++;
				continue;
			}

			const sign = changePerc >= 0 ? "+" : "";
			quoteSummaries.push(
				`${ticker}: $${price.toFixed(2)} (${sign}${changePerc.toFixed(2)}%)`,
			);
		}

		if (nullCount === tickers.length)
			return {
				endpoint,
				status: "FAIL",
				message: `No valid quotes returned`,
				detail: quoteSummaries.join("\n         "),
			};

		return {
			endpoint,
			status: nullCount > 0 ? "WARN" : "PASS",
			message: `${tickers.length - nullCount}/${tickers.length} tickers with quotes`,
			detail: quoteSummaries.join("\n         "),
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify snapshot quote payload includes expected fields for one ticker. */
async function testSnapshotFields(
	ticker: string,
	apiKey: string,
): Promise<TestResult> {
	const endpoint = `/v2/snapshot (field check)`;
	try {
		const { status, data } = await polygonGet(
			"/v2/snapshot/locale/us/markets/stocks/tickers",
			{ tickers: ticker },
			apiKey,
		);
		if (status !== 200)
			return { endpoint, status: "FAIL", message: `HTTP ${status}` };

		const tickerData = (data as Record<string, unknown>).tickers;
		if (!Array.isArray(tickerData) || tickerData.length === 0)
			return {
				endpoint,
				status: "FAIL",
				message: `No ticker data for ${ticker}`,
			};

		const t = tickerData[0] as Record<string, unknown>;
		const day = t.day as Record<string, unknown> | undefined;
		const prevDay = t.prevDay as Record<string, unknown> | undefined;

		const fields: Record<string, unknown> = {
			ticker: t.ticker,
			"day.o (open)": day?.o,
			"day.h (high)": day?.h,
			"day.l (low)": day?.l,
			"day.c (close)": day?.c,
			"day.v (volume)": day?.v,
			"prevDay.c": prevDay?.c,
			todaysChangePerc: t.todaysChangePerc,
			updated: t.updated,
		};

		const lines: string[] = [];
		let missingCount = 0;
		for (const [key, value] of Object.entries(fields)) {
			const present = value !== undefined && value !== null;
			if (!present) missingCount++;
			lines.push(
				`${present ? "\x1b[32m+\x1b[0m" : "\x1b[31m-\x1b[0m"} ${key}: ${value ?? "MISSING"}`,
			);
		}

		return {
			endpoint,
			status: missingCount === 0 ? "PASS" : "WARN",
			message: `${ticker}: ${Object.keys(fields).length - missingCount}/${Object.keys(fields).length} fields present`,
			detail: lines.join("\n         "),
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify `/v3/reference/dividends` returns dividend events for a date range. */
async function testDividends(apiKey: string): Promise<TestResult> {
	const endpoint = `/v3/reference/dividends`;
	// Look at a wider window to ensure we find some data
	const from = dateStr(30);
	const to = futureDate(30);
	try {
		const { status, data } = await polygonGet(
			endpoint,
			{
				"ex_dividend_date.gte": from,
				"ex_dividend_date.lte": to,
				limit: "10",
			},
			apiKey,
		);
		if (status !== 200) {
			let apiStatus = "";
			if (typeof data === "object" && data !== null) {
				const s = (data as Record<string, unknown>).status;
				if (typeof s === "string") apiStatus = ` (API status: ${s})`;
			}
			return {
				endpoint,
				status: "FAIL",
				message: `HTTP ${status}${apiStatus}`,
				detail: JSON.stringify(data),
			};
		}

		if (typeof data !== "object" || data === null)
			return {
				endpoint,
				status: "FAIL",
				message: `Expected object, got ${typeof data}`,
			};

		const results = (data as Record<string, unknown>).results;
		if (!Array.isArray(results))
			return {
				endpoint,
				status: "FAIL",
				message: `Expected .results array`,
				detail: JSON.stringify(Object.keys(data as object)),
			};

		if (results.length === 0)
			return {
				endpoint,
				status: "WARN",
				message: `0 dividend events for ${from} to ${to}`,
			};

		const sample = results[0] as Record<string, unknown>;
		const requiredFields = ["ticker", "ex_dividend_date", "cash_amount"];
		const missing = requiredFields.filter(
			(f) => sample[f] === undefined || sample[f] === null,
		);
		if (missing.length > 0)
			return {
				endpoint,
				status: "FAIL",
				message: `Missing fields: ${missing.join(", ")}`,
				detail: JSON.stringify(Object.keys(sample)),
			};

		const sampleLines = results.slice(0, 5).map((r: unknown) => {
			const row = r as Record<string, unknown>;
			const amount = typeof row.cash_amount === "number" ? row.cash_amount.toFixed(2) : String(row.cash_amount);
		return `${row.ticker}: ex-div ${row.ex_dividend_date} $${amount}`;
		});

		return {
			endpoint,
			status: "PASS",
			message: `${results.length} dividend events from ${from} to ${to}`,
			detail: sampleLines.join("\n         "),
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify `/v3/reference/splits` returns split events for a date range. */
async function testSplits(apiKey: string): Promise<TestResult> {
	const endpoint = `/v3/reference/splits`;
	// Use a very wide window — splits are rare
	const from = dateStr(180);
	const to = futureDate(30);
	try {
		const { status, data } = await polygonGet(
			endpoint,
			{
				"execution_date.gte": from,
				"execution_date.lte": to,
				limit: "10",
			},
			apiKey,
		);
		if (status !== 200) {
			let apiStatus = "";
			if (typeof data === "object" && data !== null) {
				const s = (data as Record<string, unknown>).status;
				if (typeof s === "string") apiStatus = ` (API status: ${s})`;
			}
			return {
				endpoint,
				status: "FAIL",
				message: `HTTP ${status}${apiStatus}`,
				detail: JSON.stringify(data),
			};
		}

		if (typeof data !== "object" || data === null)
			return {
				endpoint,
				status: "FAIL",
				message: `Expected object, got ${typeof data}`,
			};

		const results = (data as Record<string, unknown>).results;
		if (!Array.isArray(results))
			return {
				endpoint,
				status: "FAIL",
				message: `Expected .results array`,
				detail: JSON.stringify(Object.keys(data as object)),
			};

		if (results.length === 0)
			return {
				endpoint,
				status: "WARN",
				message: `0 split events for ${from} to ${to} (splits are rare — this may be fine)`,
			};

		const sample = results[0] as Record<string, unknown>;
		const requiredFields = [
			"ticker",
			"execution_date",
			"split_from",
			"split_to",
		];
		const missing = requiredFields.filter(
			(f) => sample[f] === undefined || sample[f] === null,
		);
		if (missing.length > 0)
			return {
				endpoint,
				status: "FAIL",
				message: `Missing fields: ${missing.join(", ")}`,
				detail: JSON.stringify(Object.keys(sample)),
			};

		const sampleLines = results.slice(0, 5).map((r: unknown) => {
			const row = r as Record<string, unknown>;
			return `${row.ticker}: split ${row.execution_date} ${String(row.split_to)}:${String(row.split_from)}`;
		});

		return {
			endpoint,
			status: "PASS",
			message: `${results.length} split events from ${from} to ${to}`,
			detail: sampleLines.join("\n         "),
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify `/v2/reference/news` returns news items for a ticker. */
async function testCompanyNews(
	ticker: string,
	apiKey: string,
): Promise<TestResult> {
	const endpoint = `/v2/reference/news`;
	const from = dateStr(7);
	const to = dateStr(0);
	try {
		const { status, data } = await polygonGet(
			endpoint,
			{
				ticker,
				"published_utc.gte": from,
				"published_utc.lte": to,
				limit: "5",
				sort: "published_utc",
				order: "desc",
			},
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

		const results = (data as Record<string, unknown>).results;
		if (!Array.isArray(results))
			return {
				endpoint,
				status: "FAIL",
				message: `Expected .results array`,
				detail: JSON.stringify(Object.keys(data as object)),
			};
		if (results.length === 0)
			return {
				endpoint,
				status: "WARN",
				message: `${ticker}: 0 news items (may be normal)`,
			};

		const sample = results[0] as Record<string, unknown>;
		const hasFields =
			typeof sample.title === "string" &&
			typeof sample.published_utc === "string";
		if (!hasFields)
			return {
				endpoint,
				status: "FAIL",
				message: `Missing expected fields (title, published_utc)`,
				detail: JSON.stringify(Object.keys(sample)),
			};

		return {
			endpoint,
			status: "PASS",
			message: `${ticker}: ${results.length} items`,
			detail: `Latest: "${(sample.title as string).slice(0, 80)}"`,
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify `/v1/marketstatus/now` returns the current market state. */
async function testMarketStatus(apiKey: string): Promise<TestResult> {
	const endpoint = `/v1/marketstatus/now`;
	try {
		const { status, data } = await polygonGet(endpoint, {}, apiKey);
		if (status !== 200)
			return { endpoint, status: "FAIL", message: `HTTP ${status}` };
		if (typeof data !== "object" || data === null)
			return {
				endpoint,
				status: "FAIL",
				message: `Expected object, got ${typeof data}`,
			};

		const obj = data as Record<string, unknown>;
		if (typeof obj.market !== "string")
			return {
				endpoint,
				status: "FAIL",
				message: `Expected .market string, got ${typeof obj.market}`,
				detail: JSON.stringify(data),
			};

		return {
			endpoint,
			status: "PASS",
			message: `Market is currently ${(obj.market as string).toUpperCase()}`,
			detail: obj.serverTime ? `Server time: ${obj.serverTime}` : undefined,
		};
	} catch (err) {
		return { endpoint, status: "FAIL", message: String(err) };
	}
}

/** Verify `/v1/marketstatus/upcoming` returns upcoming market events/closures. */
async function testMarketHolidays(apiKey: string): Promise<TestResult> {
	const endpoint = `/v1/marketstatus/upcoming`;
	try {
		const { status, data } = await polygonGet(endpoint, {}, apiKey);
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
				message: `0 upcoming market events`,
			};

		const sample = data[0] as Record<string, unknown>;
		const hasFields =
			typeof sample.exchange === "string" &&
			typeof sample.status === "string" &&
			typeof sample.date === "string";
		if (!hasFields)
			return {
				endpoint,
				status: "FAIL",
				message: `Missing expected fields (exchange, status, date)`,
				detail: JSON.stringify(Object.keys(sample)),
			};

		const nyseEvents = data.filter((row: unknown) => {
			if (typeof row !== "object" || row === null) return false;
			const r = row as Record<string, unknown>;
			return (
				typeof r.exchange === "string" &&
				r.exchange.includes("NYSE") &&
				r.status === "closed"
			);
		});

		const sampleLines = nyseEvents.slice(0, 5).map((r: unknown) => {
			const row = r as Record<string, unknown>;
			return `${row.date}: ${row.name} (${row.exchange})`;
		});

		return {
			endpoint,
			status: "PASS",
			message: `${data.length} upcoming events (${nyseEvents.length} NYSE closures)`,
			detail:
				sampleLines.length > 0
					? sampleLines.join("\n         ")
					: "No upcoming NYSE closures found",
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
	const apiKey = process.env.POLYGON_API_KEY;
	if (!apiKey) {
		console.error("Missing POLYGON_API_KEY in environment.");
		console.error(
			"Run with: node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-massive.ts",
		);
		process.exitCode = 2;
		return;
	}

	const tickers = parseTickers(getArgValue(args, "--tickers"));
	console.log(`\nPolygon API Verification`);
	console.log(`========================`);
	console.log(`Tickers: ${tickers.join(", ")}\n`);

	const results: TestResult[] = [];

	// Snapshot quotes (batch)
	console.log("Snapshot quotes (batch):");
	const batchResult = await testSnapshotQuotes(tickers, apiKey);
	results.push(batchResult);
	printResult(batchResult);

	// Snapshot field check (single ticker)
	console.log(`\nSnapshot field check (${tickers[0]}):`);
	const fieldResult = await testSnapshotFields(tickers[0], apiKey);
	results.push(fieldResult);
	printResult(fieldResult);

	// Reference data endpoints
	console.log("\nReference data:");
	const [divResult, splitResult] = await Promise.all([
		testDividends(apiKey),
		testSplits(apiKey),
	]);
	results.push(divResult, splitResult);
	printResult(divResult);
	printResult(splitResult);

	// Company news (migrated from Finnhub)
	console.log("\nCompany news (migrated from Finnhub):");
	for (const ticker of tickers) {
		const newsResult = await testCompanyNews(ticker, apiKey);
		results.push(newsResult);
		printResult(newsResult);
	}

	// Market status (migrated from Finnhub)
	console.log("\nMarket status (migrated from Finnhub):");
	const [marketStatusResult, marketHolidaysResult] = await Promise.all([
		testMarketStatus(apiKey),
		testMarketHolidays(apiKey),
	]);
	results.push(marketStatusResult, marketHolidaysResult);
	printResult(marketStatusResult);
	printResult(marketHolidaysResult);

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
	console.error("verify-massive failed:", error);
	process.exitCode = 1;
});
