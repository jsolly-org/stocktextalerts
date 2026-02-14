#!/usr/bin/env npx tsx
/**
 * Verify all Massive (Polygon-compatible) API endpoints return expected data.
 *
 * Endpoints tested:
 *   1. /v2/snapshot/locale/us/markets/stocks/tickers — batch snapshot quotes
 *   2. /v3/reference/dividends — ex-dividend events for a date range
 *   3. /v3/reference/splits   — stock split events for a date range
 *
 * Usage:
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-massive.ts
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-massive.ts --tickers AAPL,MSFT
 */

const MASSIVE_BASE_URL = "https://api.massive.com";
const DEFAULT_TICKERS = ["AAPL", "MSFT", "GOOG"];
const REQUEST_TIMEOUT_MS = 15_000;

// ── Helpers ──────────────────────────────────────────────────────────

function getArgValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function parseTickers(raw: string | undefined): string[] {
	if (!raw) return DEFAULT_TICKERS;
	return raw
		.split(",")
		.map((t) => t.trim().toUpperCase())
		.filter(Boolean);
}

function dateStr(daysAgo: number): string {
	const d = new Date();
	d.setDate(d.getDate() - daysAgo);
	return d.toISOString().slice(0, 10);
}

function futureDate(daysAhead: number): string {
	const d = new Date();
	d.setDate(d.getDate() + daysAhead);
	return d.toISOString().slice(0, 10);
}

async function massiveGet(
	endpoint: string,
	params: Record<string, string>,
	apiKey: string,
): Promise<{ status: number; data: unknown }> {
	const query = new URLSearchParams({ ...params, apiKey });
	const url = `${MASSIVE_BASE_URL}${endpoint}?${query.toString()}`;
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

async function testSnapshotQuotes(
	tickers: string[],
	apiKey: string,
): Promise<TestResult> {
	const endpoint = `/v2/snapshot/locale/us/markets/stocks/tickers`;
	try {
		const { status, data } = await massiveGet(
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

async function testSnapshotFields(
	ticker: string,
	apiKey: string,
): Promise<TestResult> {
	const endpoint = `/v2/snapshot (field check)`;
	try {
		const { status, data } = await massiveGet(
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

async function testDividends(apiKey: string): Promise<TestResult> {
	const endpoint = `/v3/reference/dividends`;
	// Look at a wider window to ensure we find some data
	const from = dateStr(30);
	const to = futureDate(30);
	try {
		const { status, data } = await massiveGet(
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
			return `${row.ticker}: ex-div ${row.ex_dividend_date} $${(row.cash_amount as number).toFixed(2)}`;
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

async function testSplits(apiKey: string): Promise<TestResult> {
	const endpoint = `/v3/reference/splits`;
	// Use a very wide window — splits are rare
	const from = dateStr(180);
	const to = futureDate(30);
	try {
		const { status, data } = await massiveGet(
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
			return `${row.ticker}: split ${row.execution_date} ${row.split_to}:${row.split_from}`;
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

// ── Main ─────────────────────────────────────────────────────────────

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

async function main() {
	const args = process.argv.slice(2);
	const apiKey = process.env.MASSIVE_API_KEY;
	if (!apiKey) {
		console.error("Missing MASSIVE_API_KEY in environment.");
		console.error(
			"Run with: node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/one-off-tests/verify-massive.ts",
		);
		process.exitCode = 2;
		return;
	}

	const tickers = parseTickers(getArgValue(args, "--tickers"));
	console.log(`\nMassive API Verification`);
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
