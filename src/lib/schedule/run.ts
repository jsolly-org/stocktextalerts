import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import {
	fetchMarketStatus,
	fetchStockPrices,
	type StockPriceMap,
} from "../price-fetcher";
import { toIsoOrThrow } from "../time/format";
import {
	type ScheduledNotificationTotals,
	type SupabaseAdminClient,
	USER_PROCESS_BATCH_SIZE,
} from "./helpers";
import { fetchScheduledUsers } from "./run-query";
import { processScheduledUser } from "./run-user";
import { createSmsSenderProvider } from "./run-user-sms-sender";

async function runScheduledNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	now?: DateTime;
}): Promise<ScheduledNotificationTotals> {
	const { supabase, logger, forceSend } = options;
	const sendEmail = createEmailSender();

	// Round to end of current minute so the cron picks up all notifications
	// scheduled for this minute, regardless of when within the minute Vercel
	// actually fires the cron (typically ~30s into the minute).
	const currentTime = (options.now ?? DateTime.utc()).endOf("minute");
	const currentTimeIso = toIsoOrThrow(
		currentTime,
		"Failed to format UTC ISO string",
	);
	const users = await fetchScheduledUsers({
		supabase,
		forceSend,
		currentTimeIso,
	});

	// Collect unique stock symbols across all users and fetch prices in batch
	let priceMap: StockPriceMap = new Map();
	let marketOpen = false;
	if (users.length > 0) {
		const userIds = users.map((u) => u.id);
		const { data: allUserStocks, error: userStocksError } = await supabase
			.from("user_stocks")
			.select("symbol")
			.in("user_id", userIds);

		if (userStocksError) {
			logger.error(
				"Failed to load user stocks for scheduled notifications",
				{
					action: "scheduled_notifications_run",
					userIdsCount: userIds.length,
				},
				userStocksError,
			);
			throw userStocksError;
		}

		const uniqueSymbols = [
			...new Set((allUserStocks ?? []).map((s) => s.symbol)),
		];

		if (uniqueSymbols.length > 0) {
			[priceMap, marketOpen] = await Promise.all([
				fetchStockPrices(uniqueSymbols),
				fetchMarketStatus(),
			]);
		}
	}

	const getSmsSender = createSmsSenderProvider();

	const results: ScheduledNotificationTotals[] = [];
	for (let index = 0; index < users.length; index += USER_PROCESS_BATCH_SIZE) {
		const batch = users.slice(index, index + USER_PROCESS_BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processScheduledUser({
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
					priceMap,
					marketOpen,
				}),
			),
		);
		results.push(...batchResults);
	}

	return results.reduce(
		(acc, curr) => ({
			skipped: acc.skipped + curr.skipped,
			logFailures: acc.logFailures + curr.logFailures,
			emailsSent: acc.emailsSent + curr.emailsSent,
			emailsFailed: acc.emailsFailed + curr.emailsFailed,
			smsSent: acc.smsSent + curr.smsSent,
			smsFailed: acc.smsFailed + curr.smsFailed,
		}),
		{
			skipped: 0,
			logFailures: 0,
			emailsSent: 0,
			emailsFailed: 0,
			smsSent: 0,
			smsFailed: 0,
		},
	);
}

export { runScheduledNotifications };
