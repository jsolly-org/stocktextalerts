import { DateTime } from "luxon";
import type { User, UserUpdateInput } from "../db";
import { userLocalToEtMinute } from "../time/format";
import { calculateNextSendAt } from "../time/scheduled-times";

/** User columns that enable an asset-events notification option (used for next-send-at and timezone updates). */
export const ASSET_EVENTS_OPTION_FIELDS = [
	"asset_events_include_calendar_email",
	"asset_events_include_calendar_sms",
	"asset_events_include_ipo_email",
	"asset_events_include_ipo_sms",
	"asset_events_include_analyst_email",
	"asset_events_include_analyst_sms",
	"asset_events_include_insider_email",
	"asset_events_include_insider_sms",
] as const;

/**
 * Compute `asset_events_next_send_at` when asset events preferences, daily delivery time, or timezone changes.
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
): void {
	const hasAnyAssetEventsOption = ASSET_EVENTS_OPTION_FIELDS.some(
		(field) =>
			(updates[field as keyof UserUpdateInput] as boolean | undefined) ??
			(dbUser[field as keyof typeof dbUser] as boolean),
	);

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
