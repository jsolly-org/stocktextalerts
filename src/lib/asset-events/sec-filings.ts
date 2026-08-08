/**
 * Nightly SEC EDGAR ingest + send-time loaders for the Asset Events `filings` facet.
 */
import { DateTime } from "luxon";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "../vendors/optional-vendors";
import {
	buildEdgarFilingUrl,
	delayBetweenSecRequests,
	fetchSecCompanyTickerMap,
	fetchSecMaterialFilings,
	padCik,
	resolveSecCikFromTickerMap,
} from "../vendors/sec-edgar";
import type { SecFilingLine } from "./types";

/** How long to keep stored filings (ingest prune). */
const SEC_FILINGS_RETENTION_DAYS = 14;

/** Lookback when polling submissions (keep a few days of rows in the store). */
const SEC_FILINGS_INGEST_LOOKBACK_DAYS = 3;

/** Digest display window — match insider's one-day cutoff so filings don't re-spam. */
const SEC_FILINGS_DISPLAY_LOOKBACK_DAYS = 1;

/** Cap lines shown per digest section. */
const MAX_FILINGS_IN_DIGEST = 20;

const optionalSecPolicy = { optional: true } as const;

type AssetSecFilingRow = {
	symbol: string;
	cik: string;
	accession_number: string;
	form: string;
	filed_at: string;
	primary_document: string | null;
};

/**
 * Resolve missing CIKs for tracked symbols from the SEC company tickers map,
 * then poll distinct CIKs for material 8-K / 6-K filings and upsert rows.
 */
export async function fetchAndStoreSecFilings(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<{
	cikUpdated: number;
	filingsUpserted: number;
	ciksPolled: number;
	failures: string[];
}> {
	const { supabase, logger } = options;
	const failures: string[] = [];

	const { data: trackedRows, error: symbolsError } = await supabase
		.from("user_assets")
		.select("symbol");

	if (symbolsError) {
		logger.error(
			"Failed to load tracked symbols for SEC filings",
			{ action: "fetch_sec_filings" },
			symbolsError,
		);
		throw new Error(`Failed to load tracked symbols: ${symbolsError.message}`);
	}

	const symbols = [...new Set((trackedRows ?? []).map((row) => row.symbol))];
	if (symbols.length === 0) {
		return { cikUpdated: 0, filingsUpserted: 0, ciksPolled: 0, failures: [] };
	}

	const { data: assetRows, error: assetsError } = await supabase
		.from("assets")
		.select("symbol, cik")
		.in("symbol", symbols);

	if (assetsError) {
		logger.error(
			"Failed to load assets for SEC CIK resolve",
			{ action: "fetch_sec_filings" },
			assetsError,
		);
		throw new Error(`Failed to load assets: ${assetsError.message}`);
	}

	const cikBySymbol = new Map<string, string | null>();
	for (const row of assetRows ?? []) {
		cikBySymbol.set(row.symbol, row.cik);
	}

	const missingCikSymbols = symbols.filter((symbol) => !cikBySymbol.get(symbol));
	let cikUpdated = 0;

	if (missingCikSymbols.length > 0) {
		const tickerMap = await fetchSecCompanyTickerMap(optionalSecPolicy);
		if (!tickerMap) {
			failures.push("company_tickers");
			logger.warn("SEC company tickers map unavailable; skipping CIK backfill", {
				action: "fetch_sec_filings",
				missingCount: missingCikSymbols.length,
				category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
			});
		} else {
			for (const symbol of missingCikSymbols) {
				const cik = resolveSecCikFromTickerMap(tickerMap, symbol);
				if (!cik) {
					continue;
				}
				const { error } = await supabase.from("assets").update({ cik }).eq("symbol", symbol);
				if (error) {
					logger.error(
						"Failed to update assets.cik",
						{ action: "fetch_sec_filings", symbol, cik },
						error,
					);
					failures.push(`cik_update:${symbol}`);
					continue;
				}
				cikBySymbol.set(symbol, cik);
				cikUpdated++;
			}
		}
	}

	const symbolsByCik = new Map<string, string[]>();
	for (const symbol of symbols) {
		const cik = cikBySymbol.get(symbol);
		if (!cik) continue;
		const padded = padCik(cik);
		const list = symbolsByCik.get(padded) ?? [];
		list.push(symbol);
		symbolsByCik.set(padded, list);
	}

	const sinceDate =
		DateTime.utc().minus({ days: SEC_FILINGS_INGEST_LOOKBACK_DAYS }).toISODate() ??
		DateTime.utc().toISODate() ??
		"";
	if (!sinceDate) {
		throw new Error("Failed to compute SEC filings sinceDate");
	}

	let filingsUpserted = 0;
	let ciksPolled = 0;
	const upsertRows: AssetSecFilingRow[] = [];

	for (const [cik, cikSymbols] of symbolsByCik) {
		if (ciksPolled > 0) {
			await delayBetweenSecRequests();
		}
		ciksPolled++;
		const filings = await fetchSecMaterialFilings({
			cik,
			sinceDate,
			policy: optionalSecPolicy,
		});
		if (filings === null) {
			failures.push(`submissions:${cik}`);
			continue;
		}
		for (const filing of filings) {
			const filedAt = `${filing.filingDate}T00:00:00.000Z`;
			for (const symbol of cikSymbols) {
				upsertRows.push({
					symbol,
					cik,
					accession_number: filing.accessionNumber,
					form: filing.form,
					filed_at: filedAt,
					primary_document: filing.primaryDocument,
				});
			}
		}
	}

	if (upsertRows.length > 0) {
		const { error } = await supabase.from("asset_sec_filings").upsert(upsertRows, {
			onConflict: "symbol,accession_number",
		});
		if (error) {
			logger.error(
				"Failed to upsert asset_sec_filings",
				{ action: "fetch_sec_filings", rowCount: upsertRows.length },
				error,
			);
			failures.push("filings_upsert");
		} else {
			filingsUpserted = upsertRows.length;
		}
	}

	const pruneBefore =
		DateTime.utc().minus({ days: SEC_FILINGS_RETENTION_DAYS }).toISO() ??
		new Date(Date.now() - SEC_FILINGS_RETENTION_DAYS * 86_400_000).toISOString();
	const { error: pruneError } = await supabase
		.from("asset_sec_filings")
		.delete()
		.lt("filed_at", pruneBefore);
	if (pruneError) {
		logger.error(
			"Failed to prune old asset_sec_filings",
			{ action: "fetch_sec_filings", pruneBefore },
			pruneError,
		);
		failures.push("filings_prune");
	}

	const summary = {
		action: "fetch_sec_filings" as const,
		trackedSymbols: symbols.length,
		cikUpdated,
		ciksPolled,
		filingsUpserted,
		failureCount: failures.length,
		failures,
	};
	if (failures.length > 0) {
		logger.warn("SEC filings ingest completed with failures", {
			...summary,
			category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
		});
	} else {
		logger.info("SEC filings ingest complete", summary);
	}

	return { cikUpdated, filingsUpserted, ciksPolled, failures };
}

/** Load recent stored filings for digest rendering (newest first). */
export async function loadStoredSecFilings(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	tickers: readonly string[];
	localDate: string;
}): Promise<SecFilingLine[]> {
	const { supabase, logger, tickers, localDate } = options;
	if (tickers.length === 0) return [];

	const localDt = DateTime.fromISO(localDate);
	if (!localDt.isValid) {
		logger.error(
			"Invalid localDate for SEC filings load",
			{ localDate },
			new Error(`Invalid localDate: ${localDt.invalidReason ?? "unknown"}`),
		);
		return [];
	}

	const startDate = localDt.minus({ days: SEC_FILINGS_DISPLAY_LOOKBACK_DAYS }).toISODate();
	if (!startDate) {
		logger.error(
			"Failed to format SEC filings display startDate",
			{ localDate },
			new Error("Failed to format SEC filings display startDate"),
		);
		return [];
	}

	const { data, error } = await supabase
		.from("asset_sec_filings")
		.select("symbol, cik, accession_number, form, filed_at, primary_document")
		.in("symbol", [...tickers])
		.gte("filed_at", `${startDate}T00:00:00.000Z`)
		.order("filed_at", { ascending: false })
		.limit(MAX_FILINGS_IN_DIGEST * 2);

	if (error) {
		logger.error(
			"Failed to load asset_sec_filings",
			{ action: "load_sec_filings", localDate },
			error,
		);
		return [];
	}

	const lines: SecFilingLine[] = [];
	const seenAccessions = new Set<string>();
	for (const row of data ?? []) {
		if (seenAccessions.has(row.accession_number)) continue;
		seenAccessions.add(row.accession_number);
		const filed = DateTime.fromISO(row.filed_at, { zone: "utc" });
		const dateLabel = filed.isValid ? filed.toFormat("LLL d") : row.filed_at.slice(0, 10);
		const label = `${row.symbol} ${row.form} · ${dateLabel}`;
		const url = buildEdgarFilingUrl({
			cik: row.cik,
			accessionNumber: row.accession_number,
			primaryDocument: row.primary_document,
		});
		lines.push({ label, url });
		if (lines.length >= MAX_FILINGS_IN_DIGEST) break;
	}
	return lines;
}
