import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import {
	type AssetPriceMap,
	fetchAssetPrices,
	fetchMarketStatus,
} from "../price-fetcher";
import { toIsoOrThrow } from "../time/format";
import { dispatchDailyUser } from "./dispatch-daily";
import {
	type ScheduledNotificationTotals,
	type SupabaseAdminClient,
	USER_PROCESS_BATCH_SIZE,
} from "./helpers";
import { fetchScheduledUsers } from "./run-query";
import { fetchDailyUsers } from "./run-query-daily";
import { fetchWeeklyUsers } from "./run-query-weekly";
import { processScheduledUser } from "./run-user";
import { createSmsSenderProvider } from "./run-user-sms-sender";
import { processWeeklyUser } from "./run-user-weekly";

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
 * - frequent scheduled updates (with batched price fetching)
 * - weekly calendar notifications (in-process)
 * - daily digest notifications (fan-out per user to reduce Grok bottlenecks)
 */
export async function runScheduledNotifications(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	forceSend: boolean;
	cronSecret: string;
	now?: DateTime;
}): Promise<ScheduledNotificationTotals> {
	const { supabase, logger, forceSend, cronSecret } = options;
	const sendEmail = createEmailSender();

	// Round to end of current minute so the cron picks up all notifications
	// scheduled for this minute, regardless of when within the minute Vercel
	// actually fires the cron (typically ~30s into the minute).
	const currentTime = (options.now ?? DateTime.utc()).endOf("minute");
	const currentTimeIso = toIsoOrThrow(
		currentTime,
		"Failed to format UTC ISO string",
	);
	const [scheduledUsers, dailyUsers, weeklyUsers] = await Promise.all([
		fetchScheduledUsers({
			supabase,
			logger,
			forceSend,
			currentTimeIso,
		}),
		fetchDailyUsers({
			supabase,
			logger,
			forceSend,
			currentTimeIso,
		}),
		fetchWeeklyUsers({
			supabase,
			logger,
			forceSend,
			currentTimeIso,
		}),
	]);

	// Collect unique asset symbols across scheduled users and fetch prices in batch
	let priceMap: AssetPriceMap = new Map();
	const hasAnyUsers =
		scheduledUsers.length > 0 ||
		dailyUsers.length > 0 ||
		weeklyUsers.length > 0;
	const marketStatusPromise = hasAnyUsers ? fetchMarketStatus() : null;

	if (scheduledUsers.length > 0) {
		const userIds = scheduledUsers.map((u) => u.id);
		const { data: allUserAssets, error: userAssetsError } = await supabase
			.from("user_assets")
			.select("symbol")
			.in("user_id", userIds);

		if (userAssetsError) {
			logger.error(
				"Failed to load user assets for scheduled notifications",
				{
					action: "scheduled_notifications_run",
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
			priceMap = await fetchAssetPrices(uniqueSymbols);
		}
	}

	const marketOpen = marketStatusPromise ? await marketStatusPromise : false;

	const getSmsSender = createSmsSenderProvider();

	const results: ScheduledNotificationTotals[] = [];
	for (
		let index = 0;
		index < scheduledUsers.length;
		index += USER_PROCESS_BATCH_SIZE
	) {
		const batch = scheduledUsers.slice(index, index + USER_PROCESS_BATCH_SIZE);
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

	// In-process: process weekly calendar users in batches (no Grok calls, so no fan-out needed)
	for (
		let index = 0;
		index < weeklyUsers.length;
		index += USER_PROCESS_BATCH_SIZE
	) {
		const batch = weeklyUsers.slice(index, index + USER_PROCESS_BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((user) =>
				processWeeklyUser({
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
					dispatchDailyUser({
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
