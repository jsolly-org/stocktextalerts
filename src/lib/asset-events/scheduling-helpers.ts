import { DateTime } from "luxon";
import type { User, UserUpdateInput } from "../db";
import { userLocalToEtMinute } from "../time/format";
import { calculateNextSendAt } from "../time/scheduled-times";

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
		const baseLocal = finalDailyTime ?? 540;
		const etMinutes = userLocalToEtMinute(baseLocal, finalTimezone);
		const nextUtc = calculateNextSendAt(etMinutes, DateTime.utc());
		updates.asset_events_next_send_at = nextUtc?.toISO() ?? null;
	} else if (assetEventsOptionsChanged && !hasAnyAssetEventsOption) {
		updates.asset_events_next_send_at = null;
	}
}
