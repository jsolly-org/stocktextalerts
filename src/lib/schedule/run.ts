import { DateTime } from "luxon";
import { processAssetEventsUser } from "../asset-events/process";
import { fetchAssetEventsUsers } from "../asset-events/query";
import { dispatchDailyDigestUser } from "../daily-digest/dispatch";
import { fetchDailyDigestUsers } from "../daily-digest/query";
import type { Logger } from "../logging";
import {
	type PriceAlertTotals,
	processPriceAlerts,
} from "../market-notifications/process";
import { processMarketScheduledUser } from "../market-notifications/scheduled/process";
import { fetchMarketScheduledUsers } from "../market-notifications/scheduled/query";
import { createEmailSender } from "../messaging/email/utils";
import {
	type AssetPriceMap,
	type ExtendedQuoteMap,
	fetchAssetPrices,
	fetchMarketStatus,
} from "../providers/price-fetcher";
import { toIsoOrThrow } from "../time/format";
import {
	type ScheduledNotificationTotals,
	type SupabaseAdminClient,
	USER_PROCESS_BATCH_SIZE,
} from "./helpers";
import { createSmsSenderProvider } from "./sms-sender";

// Daily fan-out can easily produce a concurrency storm; keep this bounded.
// Configure via env to tune for your Vercel plan/limits.
const DAILY_DISPATCH_BATCH_SIZE = (() => {
	const raw = process.env.SCHEDULE_DAILY_DISPATCH_BATCH_SIZE;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();

/**
 * Run all notification processors for the current minute.
 *
 * This orchestrates:
 * - market scheduled updates (with batched price fetching)
 * - asset events notifications (in-process)
 * - daily digest notifications (fan-out per user to reduce Grok bottlenecks)
 */
export async function runScheduledNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	cronSecret: string;
	now?: DateTime;
}): Promise<ScheduledNotificationTotals & { priceAlerts?: PriceAlertTotals }> {
	const { supabase, logger, forceSend, cronSecret } = options;
	const sendEmail = createEmailSender();

	// Run price alerts first — this also returns an extended quote map
	// that could be reused by scheduled notifications to avoid duplicate API calls.
	let priceAlertTotals: PriceAlertTotals | undefined;
	let priceAlertQuoteMap: ExtendedQuoteMap | undefined;
	try {
		const priceAlertResult = await processPriceAlerts({ supabase });
		priceAlertTotals = priceAlertResult.totals;
		priceAlertQuoteMap = priceAlertResult.quoteMap;

		if (priceAlertTotals.alertsTriggered > 0) {
			logger.info("Price alerts processed", {
				action: "price_alerts",
				...priceAlertTotals,
			});
		}
	} catch (error) {
		logger.error(
			"Price alerts processing failed (non-fatal)",
			{ action: "price_alerts" },
			error,
		);
	}

	// Round to end of current minute so the cron picks up all notifications
	// scheduled for this minute, regardless of when within the minute Vercel
	// actually fires the cron (typically ~30s into the minute).
	const currentTime = (options.now ?? DateTime.utc()).endOf("minute");
	const currentTimeIso = toIsoOrThrow(
		currentTime,
		"Failed to format UTC ISO string",
	);
	const [marketUsers, dailyUsers, assetEventsUsers] = await Promise.all([
		fetchMarketScheduledUsers({
			supabase,
			logger,
			forceSend,
			currentTimeIso,
		}),
		fetchDailyDigestUsers({
			supabase,
			logger,
			forceSend,
			currentTimeIso,
		}),
		fetchAssetEventsUsers({
			supabase,
			logger,
			forceSend,
			currentTimeIso,
		}),
	]);

	// Collect unique asset symbols across scheduled users and fetch prices in batch
	let priceMap: AssetPriceMap = new Map();
	const hasAnyUsers =
		marketUsers.length > 0 ||
		dailyUsers.length > 0 ||
		assetEventsUsers.length > 0;
	const marketStatusPromise = hasAnyUsers ? fetchMarketStatus() : null;

	if (marketUsers.length > 0) {
		const userIds = marketUsers.map((u) => u.id);
		const { data: allUserAssets, error: userAssetsError } = await supabase
			.from("user_assets")
			.select("symbol")
			.in("user_id", userIds);

		if (userAssetsError) {
			logger.error(
				"Failed to load user assets for scheduled notifications",
				{
					action: "market_notifications_run",
					userIdsCount: userIds.length,
				},
				userAssetsError,
			);
			throw userAssetsError;
		}

		const uniqueSymbols = [
			...new Set((allUserAssets ?? []).map((s) => s.symbol)),
		];

		if (uniqueSymbols.length > 0) {
			// Reuse quotes from price alerts when available to avoid duplicate API calls
			if (priceAlertQuoteMap && priceAlertQuoteMap.size > 0) {
				const missingSymbols = uniqueSymbols.filter(
					(s) => !priceAlertQuoteMap?.has(s),
				);
				// Start with price alert quotes (they extend AssetPrice)
				for (const symbol of uniqueSymbols) {
					const cached = priceAlertQuoteMap.get(symbol);
					if (cached) {
						priceMap.set(symbol, cached);
					}
				}
				// Fetch any symbols not covered by price alerts
				if (missingSymbols.length > 0) {
					const extraPrices = await fetchAssetPrices(missingSymbols);
					for (const [symbol, price] of extraPrices) {
						priceMap.set(symbol, price);
					}
				}
			} else {
				priceMap = await fetchAssetPrices(uniqueSymbols);
			}
		}
	}

	const marketOpen = marketStatusPromise ? await marketStatusPromise : false;

	const getSmsSender = createSmsSenderProvider();

	const results: ScheduledNotificationTotals[] = [];
	for (
		let index = 0;
		index < marketUsers.length;
		index += USER_PROCESS_BATCH_SIZE
	) {
		const batch = marketUsers.slice(index, index + USER_PROCESS_BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processMarketScheduledUser({
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

	// In-process: process asset events users in batches (no Grok calls, so no fan-out needed)
	for (
		let index = 0;
		index < assetEventsUsers.length;
		index += USER_PROCESS_BATCH_SIZE
	) {
		const batch = assetEventsUsers.slice(
			index,
			index + USER_PROCESS_BATCH_SIZE,
		);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processAssetEventsUser({
					user,
					supabase,
					logger,
					currentTime,
					sendEmail,
					getSmsSender,
				}),
			),
		);
		results.push(...batchResults);
	}

	// Fan-out: dispatch each daily user to its own serverless function
	if (dailyUsers.length > 0) {
		for (
			let index = 0;
			index < dailyUsers.length;
			index += DAILY_DISPATCH_BATCH_SIZE
		) {
			const batch = dailyUsers.slice(index, index + DAILY_DISPATCH_BATCH_SIZE);
			const dispatchResults = await Promise.allSettled(
				batch.map((user) =>
					dispatchDailyDigestUser({
						userId: user.id,
						currentTimeIso,
						cronSecret,
					}),
				),
			);

			for (const result of dispatchResults) {
				if (result.status === "fulfilled") {
					results.push(result.value);
				} else {
					logger.error(
						"Fan-out dispatch rejected",
						{ action: "dispatch_daily_user" },
						result.reason,
					);
					results.push({
						skipped: 1,
						logFailures: 0,
						emailsSent: 0,
						emailsFailed: 0,
						smsSent: 0,
						smsFailed: 0,
					});
				}
			}
		}
	}

	const scheduledTotals = results.reduce(
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

	return {
		...scheduledTotals,
		priceAlerts: priceAlertTotals,
	};
}
