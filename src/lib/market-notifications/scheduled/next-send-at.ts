import type { DateTime } from "luxon";
import type { Logger } from "../../logging";
import type { UserRecord } from "../../messaging/types";
import type { SupabaseAdminClient } from "../../schedule/helpers";
import { calculateNextMarketScheduledSendAtFromTimes } from "../../time/market-scheduled-next-send";

/** Recompute and persist `users.market_scheduled_asset_price_next_send_at` after a run. */
export async function updateUserMarketScheduledNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	const { user, supabase, logger, currentTime } = options;

	// Query filters out null market_scheduled_asset_price_times with .not()
	const scheduledTimes = user.market_scheduled_asset_price_times as number[];
	const { nextSendAt, delayReasons } =
		await calculateNextMarketScheduledSendAtFromTimes({
			localMinutesList: scheduledTimes,
			timezone: user.timezone,
			now: currentTime,
		});
	const nextSendAtIso = nextSendAt ? nextSendAt.toISO() : null;
	if (nextSendAt && !nextSendAtIso) {
		logger.error(
			"Failed to format market_scheduled_asset_price_next_send_at ISO string",
			{
				userId: user.id,
				timezone: user.timezone,
			},
		);
	}
	if (!nextSendAt) {
		logger.warn("calculateNextMarketScheduledSendAtFromTimes returned null", {
			userId: user.id,
			market_scheduled_asset_price_times:
				user.market_scheduled_asset_price_times,
			timezone: user.timezone,
		});
	}
	if (delayReasons.length > 0) {
		logger.info(
			"Advanced scheduled market next_send_at due to market closure",
			{
				userId: user.id,
				reasons: delayReasons,
				nextSendAt: nextSendAtIso ?? undefined,
			},
		);
	}

	const { error: updateError } = await supabase
		.from("users")
		.update({ market_scheduled_asset_price_next_send_at: nextSendAtIso })
		.eq("id", user.id);

	if (updateError) {
		logger.error(
			nextSendAtIso
				? "Failed to update users.market_scheduled_asset_price_next_send_at"
				: "Failed to clear users.market_scheduled_asset_price_next_send_at",
			{
				userId: user.id,
				nextSendAt: nextSendAtIso ?? undefined,
			},
			updateError,
		);
		// Do not throw: delivery may have already succeeded. Caller would otherwise
		// treat this as a full failure (stats.skipped, message_delivered: false).
	}
}
