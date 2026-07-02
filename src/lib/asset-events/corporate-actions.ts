import { isRecord } from "../types";
import { marketDataFetch } from "../vendors/massive";
import type { DividendEvent, IpoEvent, ProviderResult, SplitEvent } from "./types";

/** Fetch all ex-dividend events for a date range (market-wide). */
export async function fetchDividends(
	from: string,
	to: string,
): Promise<ProviderResult<DividendEvent>> {
	const data = await marketDataFetch(
		"/v3/reference/dividends",
		{
			"ex_dividend_date.gte": from,
			"ex_dividend_date.lte": to,
			limit: "1000",
		},
		"dividends",
	);
	if (data === null) return { data: [], failed: true };
	if (!isRecord(data)) return { data: [], failed: false };

	const results = data.results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					isRecord(item) &&
					typeof item.ticker === "string" &&
					typeof item.ex_dividend_date === "string" &&
					typeof item.cash_amount === "number",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				exDividendDate: item.ex_dividend_date as string,
				cashAmount: item.cash_amount as number,
				currency: typeof item.currency === "string" ? item.currency : "USD",
				payDate: typeof item.pay_date === "string" ? item.pay_date : null,
				frequency: typeof item.frequency === "number" ? item.frequency : null,
			})),
		failed: false,
	};
}

/** Fetch all stock splits for a date range (market-wide). */
export async function fetchSplits(from: string, to: string): Promise<ProviderResult<SplitEvent>> {
	const data = await marketDataFetch(
		"/v3/reference/splits",
		{
			"execution_date.gte": from,
			"execution_date.lte": to,
			limit: "1000",
		},
		"splits",
	);
	if (data === null) return { data: [], failed: true };
	if (!isRecord(data)) return { data: [], failed: false };

	const results = data.results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					isRecord(item) &&
					typeof item.ticker === "string" &&
					typeof item.execution_date === "string" &&
					typeof item.split_from === "number" &&
					typeof item.split_to === "number",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				executionDate: item.execution_date as string,
				splitFrom: item.split_from as number,
				splitTo: item.split_to as number,
				adjustmentType:
					typeof item.adjustment_type === "string" ? item.adjustment_type : "forward_split",
			})),
		failed: false,
	};
}

/** Fetch upcoming IPO events for a date range (market-wide). */
export async function fetchIpos(from: string, to: string): Promise<ProviderResult<IpoEvent>> {
	const data = await marketDataFetch(
		"/vX/reference/ipos",
		{
			"listing_date.gte": from,
			"listing_date.lte": to,
			limit: "1000",
		},
		"ipos",
	);
	if (data === null) return { data: [], failed: true };
	if (!isRecord(data)) return { data: [], failed: false };

	const results = data.results;
	if (!Array.isArray(results)) return { data: [], failed: false };

	return {
		data: results
			.filter(
				(item: unknown) =>
					isRecord(item) &&
					typeof item.ticker === "string" &&
					typeof item.listing_date === "string",
			)
			.map((item: Record<string, unknown>) => ({
				ticker: item.ticker as string,
				listingDate: item.listing_date as string,
				issuerName: typeof item.issuer_name === "string" ? item.issuer_name : null,
				securityType: typeof item.security_type === "string" ? item.security_type : null,
			})),
		failed: false,
	};
}
