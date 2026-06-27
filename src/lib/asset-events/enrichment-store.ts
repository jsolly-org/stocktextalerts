import { setTimeout as realDelay } from "node:timers/promises";
import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { payloadLogFields, preparePayloadForLog } from "../logging/log-payload";
import type { SupabaseAdminClient } from "../schedule/helpers";
import {
	fetchInsiderTransactions,
	fetchRecommendationTrends,
	type InsiderTransaction,
	type RecommendationTrend,
} from "../vendors/finnhub";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "../vendors/vendor-fault-tolerance";

/** Analyst rows older than this are treated as stale at send time. */
export const ANALYST_FRESHNESS_MS = 36 * 60 * 60 * 1000;

/** Insider rows older than this are deleted during ingest. */
const INSIDER_RETENTION_DAYS = 7;

const INTER_SYMBOL_DELAY_MS = 100;

const optionalFinnhubPolicy = { optional: true } as const;

type StoredFinnhubExtras = {
	analyst: Map<string, RecommendationTrend | null>;
	insider: Map<string, InsiderTransaction[]>;
	analystFetchSucceeded: boolean;
};

type AnalystConsensusRow = {
	symbol: string;
	period: string | null;
	buy: number | null;
	hold: number | null;
	sell: number | null;
	strong_buy: number | null;
	strong_sell: number | null;
	fetch_succeeded: boolean;
	fetched_at: string;
};

type InsiderTransactionRow = {
	symbol: string;
	transaction_date: string;
	name: string;
	share: number;
	change: number;
	transaction_type: string;
};

function rowToRecommendationTrend(row: AnalystConsensusRow): RecommendationTrend | null {
	if (
		row.period === null ||
		row.buy === null ||
		row.hold === null ||
		row.sell === null ||
		row.strong_buy === null ||
		row.strong_sell === null
	) {
		return null;
	}
	return {
		period: row.period,
		buy: row.buy,
		hold: row.hold,
		sell: row.sell,
		strongBuy: row.strong_buy,
		strongSell: row.strong_sell,
	};
}

function isAnalystRowFresh(fetchedAtIso: string, nowMs: number): boolean {
	const fetchedAt = Date.parse(fetchedAtIso);
	return Number.isFinite(fetchedAt) && nowMs - fetchedAt <= ANALYST_FRESHNESS_MS;
}

function insiderConflictKey(row: InsiderTransactionRow): string {
	return `${row.symbol}\0${row.transaction_date}\0${row.name}\0${row.change}`;
}

function dedupeInsiderRows(rows: InsiderTransactionRow[]): {
	rows: InsiderTransactionRow[];
	duplicateConflictKeys: string[];
	dedupeDroppedCount: number;
} {
	const byKey = new Map<string, InsiderTransactionRow>();
	const duplicateConflictKeys: string[] = [];
	for (const row of rows) {
		const key = insiderConflictKey(row);
		if (byKey.has(key)) {
			duplicateConflictKeys.push(key);
		}
		byKey.set(key, row);
	}
	const dedupedRows = [...byKey.values()];
	return {
		rows: dedupedRows,
		duplicateConflictKeys: [...new Set(duplicateConflictKeys)],
		dedupeDroppedCount: rows.length - dedupedRows.length,
	};
}

/**
 * Fetch Finnhub analyst consensus and insider transactions for tracked symbols
 * and persist to Supabase. Safe to call once per asset-events cron run.
 */
export async function fetchAndStoreFinnhubEnrichment(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
}): Promise<{ analystUpserted: number; insiderUpserted: number; enrichmentFailures: string[] }> {
	const { supabase, logger } = options;

	const { data: trackedSymbols, error: symbolsError } = await supabase
		.from("user_assets")
		.select("symbol");

	if (symbolsError) {
		logger.error(
			"Failed to load tracked symbols for Finnhub enrichment",
			{ action: "fetch_finnhub_enrichment" },
			symbolsError,
		);
		throw new Error(`Failed to load tracked symbols: ${symbolsError.message}`);
	}

	const symbols = [...new Set((trackedSymbols ?? []).map((row) => row.symbol))];
	if (symbols.length === 0) {
		return { analystUpserted: 0, insiderUpserted: 0, enrichmentFailures: [] };
	}

	const enrichmentFailures: string[] = [];
	let analystUpserted = 0;
	let insiderUpserted = 0;

	const ingestCutoffDate = DateTime.utc().minus({ days: INSIDER_RETENTION_DAYS }).toISODate() ?? "";

	for (const symbol of symbols) {
		const analystResult = await fetchRecommendationTrends(symbol, optionalFinnhubPolicy);
		if (!analystResult.httpSucceeded) {
			enrichmentFailures.push(`analyst:${symbol}`);
		} else {
			const fetchedAt = new Date().toISOString();
			const trend = analystResult.trend;
			if (trend) {
				const { error } = await supabase.from("asset_analyst_consensus").upsert(
					{
						symbol,
						period: trend.period,
						buy: trend.buy,
						hold: trend.hold,
						sell: trend.sell,
						strong_buy: trend.strongBuy,
						strong_sell: trend.strongSell,
						fetch_succeeded: true,
						fetched_at: fetchedAt,
					},
					{ onConflict: "symbol" },
				);
				if (error) {
					logger.error(
						"Failed to upsert asset_analyst_consensus",
						{ action: "fetch_finnhub_enrichment", symbol },
						error,
					);
					enrichmentFailures.push(`analyst_upsert:${symbol}`);
				} else {
					analystUpserted++;
				}
			} else {
				// HTTP OK but no trend — record success without wiping prior consensus fields.
				const { data: existing, error: selectError } = await supabase
					.from("asset_analyst_consensus")
					.select("symbol")
					.eq("symbol", symbol)
					.maybeSingle();
				if (selectError) {
					logger.error(
						"Failed to read asset_analyst_consensus before empty-success update",
						{ action: "fetch_finnhub_enrichment", symbol },
						selectError,
					);
					enrichmentFailures.push(`analyst_upsert:${symbol}`);
				} else if (existing) {
					const { error } = await supabase
						.from("asset_analyst_consensus")
						.update({ fetch_succeeded: true, fetched_at: fetchedAt })
						.eq("symbol", symbol);
					if (error) {
						logger.error(
							"Failed to update asset_analyst_consensus (empty trend)",
							{ action: "fetch_finnhub_enrichment", symbol },
							error,
						);
						enrichmentFailures.push(`analyst_upsert:${symbol}`);
					} else {
						analystUpserted++;
					}
				} else {
					const { error } = await supabase.from("asset_analyst_consensus").insert({
						symbol,
						period: null,
						buy: null,
						hold: null,
						sell: null,
						strong_buy: null,
						strong_sell: null,
						fetch_succeeded: true,
						fetched_at: fetchedAt,
					});
					if (error) {
						logger.error(
							"Failed to insert asset_analyst_consensus (empty trend)",
							{ action: "fetch_finnhub_enrichment", symbol },
							error,
						);
						enrichmentFailures.push(`analyst_upsert:${symbol}`);
					} else {
						analystUpserted++;
					}
				}
			}
		}

		const insiderTx = await fetchInsiderTransactions(symbol, {
			cutoffDate: ingestCutoffDate,
			policy: optionalFinnhubPolicy,
			maxResults: 50,
		});
		if (insiderTx.length === 0) {
			// Empty may mean no trades or fetch failure; ingest does not treat as failure.
		}

		if (insiderTx.length > 0) {
			const rawRows: InsiderTransactionRow[] = insiderTx.map((tx) => ({
				symbol,
				transaction_date: tx.transactionDate,
				name: tx.name,
				share: tx.share,
				change: tx.change,
				transaction_type: tx.transactionType,
			}));
			const { rows, duplicateConflictKeys, dedupeDroppedCount } = dedupeInsiderRows(rawRows);
			const { error } = await supabase.from("asset_insider_transactions").upsert(rows, {
				onConflict: "symbol,transaction_date,name,change",
			});
			if (error) {
				const proposedPayload = preparePayloadForLog(rows);
				logger.error(
					"Failed to upsert asset_insider_transactions",
					{
						action: "fetch_finnhub_enrichment",
						symbol,
						rawRowCount: rawRows.length,
						dedupedRowCount: rows.length,
						dedupeDroppedCount,
						duplicateConflictKeys,
						...payloadLogFields(proposedPayload, "proposedRows"),
					},
					error,
				);
				enrichmentFailures.push(`insider_upsert:${symbol}`);
			} else {
				insiderUpserted += rows.length;
			}
		}

		await realDelay(INTER_SYMBOL_DELAY_MS);
	}

	const retentionCutoff = DateTime.utc().minus({ days: INSIDER_RETENTION_DAYS }).toISODate();
	if (retentionCutoff) {
		const { error: deleteError } = await supabase
			.from("asset_insider_transactions")
			.delete()
			.lt("transaction_date", retentionCutoff);
		if (deleteError) {
			logger.error(
				"Failed to prune old asset_insider_transactions",
				{ action: "fetch_finnhub_enrichment", retentionCutoff },
				deleteError,
			);
		}
	}

	if (enrichmentFailures.length > 0) {
		logger.warn("Finnhub enrichment ingest had failures", {
			action: "fetch_finnhub_enrichment",
			category: OPTIONAL_VENDOR_DEGRADED_CATEGORY,
			enrichmentFailures,
			analystUpserted,
			insiderUpserted,
		});
	} else {
		logger.info("Finnhub enrichment stored", {
			action: "fetch_finnhub_enrichment",
			analystUpserted,
			insiderUpserted,
			symbolCount: symbols.length,
		});
	}

	return { analystUpserted, insiderUpserted, enrichmentFailures };
}

/** Load persisted analyst/insider enrichment for notification rendering. */
export async function loadStoredFinnhubExtras(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	tickers: readonly string[];
	localDate: string;
	includeAnalyst: boolean;
	includeInsider: boolean;
}): Promise<StoredFinnhubExtras> {
	const { supabase, logger, tickers, localDate, includeAnalyst, includeInsider } = options;
	const result: StoredFinnhubExtras = {
		analyst: new Map(),
		insider: new Map(),
		analystFetchSucceeded: false,
	};

	if (tickers.length === 0) {
		return result;
	}

	const nowMs = Date.now();

	if (includeAnalyst) {
		const { data, error } = await supabase
			.from("asset_analyst_consensus")
			.select(
				"symbol, period, buy, hold, sell, strong_buy, strong_sell, fetch_succeeded, fetched_at",
			)
			.in("symbol", [...tickers]);

		if (error) {
			logger.error(
				"Failed to load asset_analyst_consensus",
				{ action: "load_finnhub_enrichment" },
				error,
			);
		} else {
			let freshSuccessCount = 0;
			for (const symbol of tickers) {
				result.analyst.set(symbol, null);
			}
			for (const row of (data ?? []) as AnalystConsensusRow[]) {
				if (!row.fetch_succeeded || !isAnalystRowFresh(row.fetched_at, nowMs)) {
					continue;
				}
				freshSuccessCount++;
				result.analyst.set(row.symbol, rowToRecommendationTrend(row));
			}
			result.analystFetchSucceeded = freshSuccessCount > 0;
		}
	}

	if (includeInsider) {
		const insiderCutoff =
			DateTime.fromISO(localDate).minus({ days: 1 }).toISODate() ??
			new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

		const { data, error } = await supabase
			.from("asset_insider_transactions")
			.select("symbol, transaction_date, name, share, change, transaction_type")
			.in("symbol", [...tickers])
			.gte("transaction_date", insiderCutoff)
			.order("transaction_date", { ascending: false });

		if (error) {
			logger.error(
				"Failed to load asset_insider_transactions",
				{ action: "load_finnhub_enrichment" },
				error,
			);
		} else {
			for (const symbol of tickers) {
				result.insider.set(symbol, []);
			}
			for (const row of (data ?? []) as InsiderTransactionRow[]) {
				const list = result.insider.get(row.symbol) ?? [];
				if (list.length >= 5) continue;
				list.push({
					name: row.name,
					share: Number(row.share),
					change: Number(row.change),
					transactionType: row.transaction_type,
					transactionDate: row.transaction_date,
				});
				result.insider.set(row.symbol, list);
			}
		}
	}

	return result;
}
