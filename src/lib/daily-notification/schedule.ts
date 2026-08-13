import { DateTime } from "luxon";
import { US_BEFORE_OPEN_EASTERN_MINUTES, US_MARKET_TIMEZONE } from "../constants";
import type { SupabaseAdminClient } from "../db/supabase";
import type { UserUpdateInput } from "../db/types";
import type { Logger } from "../logging";
import { calculateNextSendAt } from "../time/schedule/next-send";
import type { UserRecord } from "../types";
import { userHasHumanDailyDigest } from "./eligibility";

const MAX_WEEKEND_SKIP_ITERATIONS = 16;

/**
 * Next UTC ISO for the locked 09:00 ET digest slot, skipping Sat/Sun.
 * Holidays are skipped at send time in processDailyDigestUser.
 */
export function calculateDailyNotificationNextSendAtIso(options: {
	now: DateTime;
	hasDailyNotification: boolean;
}): string | null {
	if (!options.hasDailyNotification) {
		return null;
	}
	let cursor = options.now;
	for (let i = 0; i < MAX_WEEKEND_SKIP_ITERATIONS; i++) {
		const nextUtc = calculateNextSendAt(US_BEFORE_OPEN_EASTERN_MINUTES, cursor);
		if (!nextUtc) {
			return null;
		}
		const eastern = nextUtc.setZone(US_MARKET_TIMEZONE);
		if (eastern.weekday !== 6 && eastern.weekday !== 7) {
			return nextUtc.toISO() ?? null;
		}
		cursor = nextUtc.plus({ seconds: 1 });
	}
	return null;
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
		dailyTimeChanged,
		timezoneChanged,
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
		updates.daily_notification_next_send_at = calculateDailyNotificationNextSendAtIso({
			now: currentTime,
			hasDailyNotification: true,
		});
	} else if (dailyOptionsChanged && !hasDailyNotification) {
		updates.daily_notification_next_send_at = null;
	} else if (dailyTimeChanged && options.finalDailyTime === null && !hasDailyNotification) {
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
	const hasDaily = userHasHumanDailyDigest(user);
	if (!hasDaily) {
		return persistDailyNotificationNextSendAt({
			userId: user.id,
			supabase,
			logger,
			nextSendAtIso: null,
		});
	}
	const nextSendAtIso = calculateDailyNotificationNextSendAtIso({
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
