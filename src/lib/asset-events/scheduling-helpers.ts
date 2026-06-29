import { DateTime } from "luxon";
import type { User, UserUpdateInput } from "../db";
import { userLocalToEtMinute } from "../time/conversion";
import { calculateNextSendAt } from "../time/schedule/next-send";

/** Default local delivery minute when asset events is enabled but daily_digest_time is unset. */
export const DEFAULT_ASSET_EVENTS_DELIVERY_MINUTES = 540; // 9:00 AM

/**
 * Compute the next asset-events send timestamp (UTC ISO) from delivery time and timezone.
 *
 * Falls back to {@link DEFAULT_ASSET_EVENTS_DELIVERY_MINUTES} when `dailyDigestTime` is null.
 */
export function calculateAssetEventsNextSendAtIso(options: {
	dailyDigestTime: number | null;
	timezone: string;
	now: DateTime;
}): string | null {
	const baseLocal = options.dailyDigestTime ?? DEFAULT_ASSET_EVENTS_DELIVERY_MINUTES;
	const etMinutes = userLocalToEtMinute(baseLocal, options.timezone);
	const nextUtc = calculateNextSendAt(etMinutes, options.now);
	return nextUtc?.toISO() ?? null;
}

/**
 * Compute `asset_events_next_send_at` when asset events preferences, daily delivery time, or timezone changes.
 *
 * Asset-events per-option preferences now live in `notification_preferences`, so
 * the caller resolves the post-update asset-events-enabled state and passes it in
 * (`hasAnyAssetEventsOption`) along with whether it changed (`assetEventsOptionsChanged`).
 *
 * Mutates `updates` in-place so callers can compose a single `users` table update payload.
 */
export function computeAssetEventsNextSendAt(
	updates: UserUpdateInput,
	dbUser: User,
	finalDailyTime: number | null,
	finalTimezone: string,
	timezoneChanged: boolean,
	dailyTimeChanged: boolean,
	assetEventsOptionsChanged: boolean,
	hasAnyAssetEventsOption: boolean,
): void {
	const needsRepair =
		hasAnyAssetEventsOption &&
		dbUser.asset_events_next_send_at === null &&
		updates.asset_events_next_send_at === undefined;

	if (
		(timezoneChanged || dailyTimeChanged || assetEventsOptionsChanged || needsRepair) &&
		hasAnyAssetEventsOption
	) {
		updates.asset_events_next_send_at = calculateAssetEventsNextSendAtIso({
			dailyDigestTime: finalDailyTime,
			timezone: finalTimezone,
			now: DateTime.utc(),
		});
	} else if (assetEventsOptionsChanged && !hasAnyAssetEventsOption) {
		updates.asset_events_next_send_at = null;
	}
}
