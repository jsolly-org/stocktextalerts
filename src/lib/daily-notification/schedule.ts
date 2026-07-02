import { DateTime } from "luxon";
import type { SupabaseAdminClient } from "../db/supabase";
import type { UserUpdateInput } from "../db/types";
import type { Logger } from "../logging";
import { userLocalToEtMinute } from "../time/conversion";
import { calculateNextSendAt } from "../time/schedule/next-send";
import type { UserRecord } from "../types";
import { DEFAULT_DAILY_NOTIFICATION_DELIVERY_MINUTES } from "./constants";
import { hasAnyDailyNotificationFacet } from "./eligibility";

/** Read the daily notification next-send cursor. */
export function readDailyNotificationNextSendAt(user: UserRecord): string | null {
	return user.daily_notification_next_send_at;
}

/** Compute the next UTC ISO for the daily notification slot. */
function calculateDailyNotificationNextSendAtIso(options: {
	dailyNotificationTime: number | null;
	timezone: string;
	now: DateTime;
	hasDailyNotification: boolean;
}): string | null {
	if (!options.hasDailyNotification) {
		return null;
	}
	const baseLocal = options.dailyNotificationTime ?? DEFAULT_DAILY_NOTIFICATION_DELIVERY_MINUTES;
	const etMinutes = userLocalToEtMinute(baseLocal, options.timezone);
	const nextUtc = calculateNextSendAt(etMinutes, options.now);
	return nextUtc?.toISO() ?? null;
}

/** Persist the daily notification schedule cursor. */
export async function persistDailyNotificationNextSendAt(options: {
	userId: string;
	supabase: SupabaseAdminClient;
	logger: Logger;
	nextSendAtIso: string | null;
}): Promise<void> {
	const { userId, supabase, logger, nextSendAtIso } = options;
	const update: UserUpdateInput = {
		daily_notification_next_send_at: nextSendAtIso,
	};
	const { error } = await supabase.from("users").update(update).eq("id", userId);
	if (error) {
		logger.error(
			nextSendAtIso
				? "Failed to update daily notification next_send_at"
				: "Failed to clear daily notification next_send_at",
			{ userId, daily_notification_next_send_at: nextSendAtIso },
			error,
		);
	}
}

/** Apply daily notification next-send recomputation to an in-flight users update payload. */
export function applyDailyNotificationNextSendAtToUserUpdate(options: {
	updates: Record<string, unknown>;
	dbUser: Pick<
		UserRecord,
		"daily_notification_time" | "timezone" | "daily_notification_next_send_at"
	>;
	finalDailyTime: number | null;
	finalTimezone: string;
	timezoneChanged: boolean;
	dailyTimeChanged: boolean;
	dailyOptionsChanged: boolean;
	hasDailyNotification: boolean;
	currentTime?: DateTime;
}): void {
	const {
		updates,
		dbUser,
		finalDailyTime,
		finalTimezone,
		timezoneChanged,
		dailyTimeChanged,
		dailyOptionsChanged,
		hasDailyNotification,
		currentTime = DateTime.utc(),
	} = options;

	const needsRepair =
		hasDailyNotification &&
		dbUser.daily_notification_next_send_at == null &&
		updates.daily_notification_next_send_at === undefined;

	if (
		(timezoneChanged || dailyTimeChanged || dailyOptionsChanged || needsRepair) &&
		hasDailyNotification
	) {
		const localMinutes = finalDailyTime ?? DEFAULT_DAILY_NOTIFICATION_DELIVERY_MINUTES;
		const iso = calculateDailyNotificationNextSendAtIso({
			dailyNotificationTime: localMinutes,
			timezone: finalTimezone,
			now: currentTime,
			hasDailyNotification: true,
		});
		updates.daily_notification_next_send_at = iso;
	} else if (dailyOptionsChanged && !hasDailyNotification) {
		updates.daily_notification_next_send_at = null;
	} else if (dailyTimeChanged && finalDailyTime === null && !hasDailyNotification) {
		updates.daily_notification_next_send_at = null;
	}
}

/** Recompute and persist the daily notification next-send cursor for a user. */
export async function updateUserDailyNotificationNextSendAt(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	currentTime: DateTime;
}): Promise<void> {
	const { user, supabase, logger, currentTime } = options;
	const hasDaily = hasAnyDailyNotificationFacet(user.prefs);
	if (!hasDaily) {
		return persistDailyNotificationNextSendAt({
			userId: user.id,
			supabase,
			logger,
			nextSendAtIso: null,
		});
	}
	const localMinutes = user.daily_notification_time ?? DEFAULT_DAILY_NOTIFICATION_DELIVERY_MINUTES;
	const nextSendAtIso = calculateDailyNotificationNextSendAtIso({
		dailyNotificationTime: localMinutes,
		timezone: user.timezone,
		now: currentTime,
		hasDailyNotification: true,
	});
	return persistDailyNotificationNextSendAt({
		userId: user.id,
		supabase,
		logger,
		nextSendAtIso,
	});
}
