import { rootLogger } from "../../logging";
import { type FinnhubFetchPolicy, finnhubFetch } from "./client";

export interface InsiderTransaction {
	name: string;
	share: number;
	change: number;
	transactionType: string;
	transactionDate: string;
}

function parseInsiderTransactionsPayload(
	symbol: string,
	data: unknown,
	cutoffDate: string | null,
	maxResults = 5,
): InsiderTransaction[] {
	if (typeof data !== "object" || data === null) {
		rootLogger.error(
			"Invalid Finnhub insider-transactions payload shape",
			{ symbol, payloadType: typeof data },
			new Error("Invalid Finnhub insider-transactions payload shape"),
		);
		return [];
	}

	const transactions = (data as Record<string, unknown>).data;
	if (!Array.isArray(transactions)) {
		rootLogger.error(
			"Invalid Finnhub insider-transactions data field",
			{ symbol, dataType: typeof transactions },
			new Error("Invalid Finnhub insider-transactions data field"),
		);
		return [];
	}

	return transactions
		.filter(
			(item: unknown) =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as Record<string, unknown>).name === "string" &&
				typeof (item as Record<string, unknown>).change === "number" &&
				typeof (item as Record<string, unknown>).transactionDate === "string" &&
				(cutoffDate === null ||
					((item as Record<string, unknown>).transactionDate as string) >= cutoffDate),
		)
		.slice(0, maxResults)
		.map((item: Record<string, unknown>) => ({
			name: item.name as string,
			share: typeof item.share === "number" ? (item.share as number) : 0,
			change: item.change as number,
			transactionType:
				typeof item.transactionType === "string" ? (item.transactionType as string) : "",
			transactionDate: item.transactionDate as string,
		}));
}

/** Fetch insider transactions for a ticker (validated; optional date cutoff). */
export async function fetchInsiderTransactions(
	symbol: string,
	options?: { cutoffDate?: string | null; policy?: FinnhubFetchPolicy; maxResults?: number },
): Promise<InsiderTransaction[]> {
	const data = await finnhubFetch(
		"/stock/insider-transactions",
		{ symbol },
		"insider-transactions",
		options?.policy,
	);
	// `null` means finnhubFetch already logged the failure; don't double-log.
	if (data === null) return [];

	const cutoffDate =
		options?.cutoffDate === undefined
			? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
			: options.cutoffDate;

	return parseInsiderTransactionsPayload(symbol, data, cutoffDate, options?.maxResults ?? 5);
}
