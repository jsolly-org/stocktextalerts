import { isRecord } from "../../types";
import { marketDataFetch } from "../../vendors/massive";

/** Authoritative delisting record for a single symbol. */
interface TickerReferenceResult {
	symbol: string;
	active: false;
	delistedUtc: string;
	primaryExchange: string | null;
	name: string | null;
}

export type TickerReferenceStatus =
	| { status: "delisted"; result: TickerReferenceResult }
	| { status: "unknown"; symbol: string }
	| { status: "provider_error"; symbol: string };

async function fetchTickerReference(symbol: string): Promise<TickerReferenceStatus> {
	const data = await marketDataFetch(
		"/v3/reference/tickers",
		{ ticker: symbol, active: "false", limit: "1" },
		"ticker-reference",
		{ symbol },
	);

	if (data === null) return { status: "provider_error", symbol };
	if (!isRecord(data)) return { status: "unknown", symbol };

	const results = data.results;
	if (!Array.isArray(results) || results.length === 0) {
		return { status: "unknown", symbol };
	}

	const first = results[0];
	if (!isRecord(first)) {
		return { status: "unknown", symbol };
	}
	const row = first;

	if (row.active !== false) return { status: "unknown", symbol };

	const rawDelistedUtc = row.delisted_utc;
	if (typeof rawDelistedUtc !== "string" || rawDelistedUtc.length < 10) {
		return { status: "unknown", symbol };
	}

	return {
		status: "delisted",
		result: {
			symbol,
			active: false,
			delistedUtc: rawDelistedUtc.slice(0, 10),
			primaryExchange: typeof row.primary_exchange === "string" ? row.primary_exchange : null,
			name: typeof row.name === "string" ? row.name : null,
		},
	};
}

/** Concurrent reference lookup for multiple symbols with bounded parallelism. */
export async function fetchTickerReferences(
	symbols: string[],
	concurrency = 5,
): Promise<TickerReferenceStatus[]> {
	if (symbols.length === 0) return [];
	const results: TickerReferenceStatus[] = [];
	const queue = [...symbols];

	async function worker(): Promise<void> {
		while (true) {
			const next = queue.shift();
			if (next === undefined) return;
			results.push(await fetchTickerReference(next));
		}
	}

	const workerCount = Math.min(concurrency, symbols.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
