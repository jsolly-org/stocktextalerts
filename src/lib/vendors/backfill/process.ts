import { DateTime } from "luxon";
import { fetchAndStoreAssetEvents } from "../../asset-events/fetch";
import type { Logger } from "../../logging";
import { fetchDailyOHLCV } from "../../market-data/bars";
import {
	dailyBarsToCloseRows,
	storeDailyCloseRows,
	storePriceHistoryRows,
} from "../../market-notifications/price-history-cache";
import type { SupabaseAdminClient } from "../../schedule/helpers";
import type { VendorBackfillMessage } from "./messages";

async function backfillDailyClosesForSymbol(
	supabase: SupabaseAdminClient,
	symbol: string,
	from: string,
	to: string,
): Promise<boolean> {
	const bars = await fetchDailyOHLCV(symbol, from, to);
	if (!bars || bars.length === 0) {
		return true;
	}
	const rows = dailyBarsToCloseRows(symbol, bars);
	if (rows.length === 0) {
		return true;
	}
	return storeDailyCloseRows(supabase, rows);
}

async function processNewSymbolWarmup(
	supabase: SupabaseAdminClient,
	symbol: string,
	logger: Logger,
): Promise<{ ok: boolean; failedProviders: string[] }> {
	const thisMonday = DateTime.utc().startOf("week");
	const nextMonday = thisMonday.plus({ weeks: 1 });
	const weeks = [
		{
			weekStart: thisMonday.toISODate(),
			weekEnd: thisMonday.plus({ days: 4 }).toISODate(),
		},
		{
			weekStart: nextMonday.toISODate(),
			weekEnd: nextMonday.plus({ days: 4 }).toISODate(),
		},
	];

	const failedProviders: string[] = [];
	for (const week of weeks) {
		if (!week.weekStart || !week.weekEnd) continue;
		const result = await fetchAndStoreAssetEvents({
			supabase,
			weekStart: week.weekStart,
			weekEnd: week.weekEnd,
			logger,
		});
		failedProviders.push(...result.failedProviders);
	}

	const to = new Date().toISOString().slice(0, 10);
	const from = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const dailyOk = await backfillDailyClosesForSymbol(supabase, symbol, from, to);

	return {
		ok: failedProviders.length === 0 && dailyOk,
		failedProviders,
	};
}

export async function processVendorBackfillMessage(
	message: VendorBackfillMessage,
	supabase: SupabaseAdminClient,
	logger: Logger,
): Promise<boolean> {
	switch (message.kind) {
		case "asset-events": {
			const result = await fetchAndStoreAssetEvents({
				supabase,
				weekStart: message.weekStart,
				weekEnd: message.weekEnd,
				providers: message.providers,
				logger,
			});
			return result.failedProviders.length === 0;
		}
		case "daily-closes": {
			let allOk = true;
			for (const symbol of message.symbols) {
				const ok = await backfillDailyClosesForSymbol(supabase, symbol, message.from, message.to);
				if (!ok) allOk = false;
			}
			return allOk;
		}
		case "price-history-store": {
			return storePriceHistoryRows(supabase, message.rows);
		}
		case "new-symbol-warmup": {
			const result = await processNewSymbolWarmup(supabase, message.symbol, logger);
			return result.ok;
		}
		default: {
			const _exhaustive: never = message;
			return _exhaustive;
		}
	}
}
