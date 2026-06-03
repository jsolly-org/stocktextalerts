/**
 * Pre-compute phase for upcoming notifications.
 *
 * This module is the "prepare" side of the pre-compute/deliver pipeline. It
 * queries users whose next_send_at falls within the upcoming 30-second window,
 * runs the full processing pipeline (prices, Grok, Finnhub, formatting), and
 * writes the rendered content to `staged_notifications`. The next pass's
 * deliver phase will send this content near-instantly at the scheduled time.
 *
 * Daily digest: dispatched via fan-out (same as normal delivery) with the
 *   `precompute` flag, so each user gets its own serverless function timeout.
 */

import type { DateTime } from "luxon";
import { dispatchDailyDigestUser } from "../daily-digest/dispatch";
import { fetchUpcomingDailyDigestUsers } from "../daily-digest/query-upcoming";
import type { Logger } from "../logging";
import { createEmailSender } from "../messaging/email/utils";
import { getCurrentMarketSession } from "../providers/price-fetcher";
import type { ScheduledNotificationTotals, SupabaseAdminClient } from "../schedule/helpers";
import { createSmsSenderProvider } from "../schedule/sms-sender";
import { toIsoOrThrow } from "../time/format";

/** Pre-compute window in seconds (look ahead this far). */
const PRECOMPUTE_WINDOW_SECONDS = 30;

/** Daily fan-out batch size for pre-compute dispatching. */
const DAILY_DISPATCH_BATCH_SIZE = (() => {
	const raw = process.env.SCHEDULE_DAILY_DISPATCH_BATCH_SIZE;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();

/** Pre-compute daily digest notifications for users due in the next 30 seconds. */
export async function precomputeDailyDigest(options: {
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
	/** When provided by the scheduler, avoids a redundant `/v1/marketstatus/now` call. */
	marketOpen?: boolean;
}): Promise<ScheduledNotificationTotals> {
	const { supabase, logger, currentTime } = options;
	const stats: ScheduledNotificationTotals = {
		skipped: 0,
		logFailures: 0,
		emailsSent: 0,
		emailsFailed: 0,
		smsSent: 0,
		smsFailed: 0,
	};

	const afterTimeIso = toIsoOrThrow(currentTime, "Failed to format afterTime");
	const beforeTime = currentTime.plus({ seconds: PRECOMPUTE_WINDOW_SECONDS });
	const beforeTimeIso = toIsoOrThrow(beforeTime, "Failed to format beforeTime");

	let upcomingUsers: Awaited<ReturnType<typeof fetchUpcomingDailyDigestUsers>>;
	try {
		upcomingUsers = await fetchUpcomingDailyDigestUsers({
			supabase,
			logger,
			afterTimeIso,
			beforeTimeIso,
		});
	} catch (error) {
		logger.error(
			"Failed to fetch upcoming daily users for precompute",
			{ action: "precompute_daily" },
			error,
		);
		return stats;
	}

	if (upcomingUsers.length === 0) {
		return stats;
	}

	const currentTimeIso = toIsoOrThrow(currentTime, "Failed to format currentTime");

	logger.info("Pre-computing daily digest notifications", {
		action: "precompute_daily",
		userCount: upcomingUsers.length,
		window: `${afterTimeIso} → ${beforeTimeIso}`,
	});

	// Fetch market status once for fan-out when the scheduler did not already resolve it.
	//
	// Do not precompute and pass a shared market-closure label here: the daily
	// digest formatter must classify closures from each user's scheduled send
	// instant, not the scheduler's current clock time. Near US midnight those can
	// land on different market dates.
	const marketOpen = options.marketOpen ?? (await getCurrentMarketSession()) === "regular";
	const sendEmail = createEmailSender();
	const getSmsSender = createSmsSenderProvider();

	for (let index = 0; index < upcomingUsers.length; index += DAILY_DISPATCH_BATCH_SIZE) {
		const batch = upcomingUsers.slice(index, index + DAILY_DISPATCH_BATCH_SIZE);
		const dispatchResults = await Promise.allSettled(
			batch.map((user) =>
				dispatchDailyDigestUser({
					userId: user.id,
					currentTimeIso,
					precompute: true,
					marketOpen,
					supabase,
					sendEmail,
					getSmsSender,
				}),
			),
		);

		for (const result of dispatchResults) {
			if (result.status === "fulfilled") {
				stats.skipped += result.value.skipped;
			} else {
				logger.error(
					"Precompute daily dispatch rejected",
					{ action: "precompute_daily" },
					result.reason,
				);
				stats.skipped++;
			}
		}
	}

	return stats;
}
