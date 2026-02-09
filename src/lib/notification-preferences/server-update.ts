import { DateTime } from "luxon";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
import { calculateNextMondaySendAt } from "../schedule/run-user-weekly-next-send-at";
import { calculateNextSendAt } from "../time/scheduled-times";
import {
	computeNextSendAtIso,
	parseScheduledTimes,
	serializeTimes,
} from "./scheduled-times";

interface ParsedNotificationPreferencesForm {
	price_notifications_enabled?: boolean;
	timezone?: string;
	email_notifications_enabled?: boolean;
	sms_notifications_enabled?: boolean;
	scheduled_update_times?: string[];
	only_notify_when_market_open?: boolean;
	daily_only_notify_when_market_open?: boolean;
	daily_delivery_time?: number;
	daily_include_news?: boolean;
	daily_include_rumors?: boolean;
	daily_include_analyst?: boolean;
	daily_include_insider?: boolean;
	weekly_include_earnings?: boolean;
	weekly_include_dividends?: boolean;
}

export function buildNotificationPreferencesUpdatePayload(options: {
	parsedData: ParsedNotificationPreferencesForm;
	formData: FormData;
	rawTimesValue: string | null;
	dbUser: User;
	logger?: Logger;
}): UserUpdateInput {
	const { parsedData, formData, rawTimesValue, dbUser, logger } = options;

	let parsedTimes: number[] | null | undefined;
	if (rawTimesValue === "") {
		parsedTimes = [];
	} else if (parsedData.scheduled_update_times !== undefined) {
		const result = parseScheduledTimes(parsedData.scheduled_update_times);
		if (!result.ok) {
			logger?.info(
				"Invalid scheduled times in notification preferences payload",
				{
					action: "notification_preferences_update",
					userId: dbUser.id,
					reason: result.reason,
				},
			);
			throw new Error(`Invalid schedule: ${result.reason}`);
		}
		parsedTimes = result.times;
	} else {
		parsedTimes = undefined;
	}

	let normalizedTimes: number[] | null | undefined = parsedTimes;
	if (normalizedTimes && normalizedTimes.length === 0) {
		normalizedTimes = null;
	}

	/* =============
	Only persist booleans the form actually submitted (unchecked controls are often omitted)
	============= */
	function boolFromForm(
		field: keyof ParsedNotificationPreferencesForm,
		fallback = false,
	): Record<string, boolean> | Record<string, never> {
		return formData.has(field)
			? { [field]: (parsedData[field] as boolean | undefined) ?? fallback }
			: {};
	}

	const safeNotificationPreferenceUpdates: UserUpdateInput = omitUndefined({
		timezone: parsedData.timezone,
		scheduled_update_times: normalizedTimes,
		...boolFromForm("price_notifications_enabled", true),
		...boolFromForm("daily_include_news"),
		...boolFromForm("daily_include_rumors"),
		...boolFromForm("daily_include_analyst"),
		...boolFromForm("daily_include_insider"),
		...boolFromForm("weekly_include_earnings"),
		...boolFromForm("weekly_include_dividends"),
		...boolFromForm("email_notifications_enabled"),
		...boolFromForm("sms_notifications_enabled"),
		...boolFromForm("only_notify_when_market_open"),
		...boolFromForm("daily_only_notify_when_market_open"),
		...(formData.has("daily_delivery_time")
			? { daily_delivery_time: parsedData.daily_delivery_time ?? null }
			: {}),
	});

	const timezoneChanged =
		safeNotificationPreferenceUpdates.timezone !== undefined &&
		safeNotificationPreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safeNotificationPreferenceUpdates.scheduled_update_times !== undefined &&
		serializeTimes(safeNotificationPreferenceUpdates.scheduled_update_times) !==
			serializeTimes(dbUser.scheduled_update_times ?? null);

	const dailyTimeChanged =
		safeNotificationPreferenceUpdates.daily_delivery_time !== undefined &&
		safeNotificationPreferenceUpdates.daily_delivery_time !==
			dbUser.daily_delivery_time;

	const finalTimezone =
		safeNotificationPreferenceUpdates.timezone ?? dbUser.timezone;
	const finalTimes =
		safeNotificationPreferenceUpdates.scheduled_update_times !== undefined
			? safeNotificationPreferenceUpdates.scheduled_update_times
			: dbUser.scheduled_update_times;

	/* =============
	Derive "scheduled updates enabled" from the schedule itself to prevent flag/time drift
	============= */
	const hasTimes = finalTimes !== null && finalTimes.length > 0;

	const finalDailyTime =
		safeNotificationPreferenceUpdates.daily_delivery_time !== undefined
			? safeNotificationPreferenceUpdates.daily_delivery_time
			: dbUser.daily_delivery_time;

	/* =============
	Derive daily enabled from having a delivery time to avoid duplicating state in the DB
	============= */
	const hasDailyTime = finalDailyTime !== null;

	/* =============
	Self-heal: repair missing next_send_at so scheduling doesn't stall
	============= */
	const needsNextSendAtRepair =
		hasTimes &&
		dbUser.next_send_at === null &&
		safeNotificationPreferenceUpdates.next_send_at === undefined;

	/* =============
	Only recompute next_send_at when schedule inputs changed (or we're repairing a missing value) to avoid churn
	============= */
	if ((timezoneChanged || timeChanged || needsNextSendAtRepair) && hasTimes) {
		safeNotificationPreferenceUpdates.next_send_at = computeNextSendAtIso(
			finalTimes,
			finalTimezone,
			{ userId: dbUser.id, finalTimes, finalTimezone },
			logger,
		);
	} else if (timeChanged && !hasTimes) {
		/* =============
		Prevent a stale next_send_at from keeping scheduling "alive" after the schedule is cleared
		============= */
		safeNotificationPreferenceUpdates.next_send_at = null;
	}

	/* =============
	Same constraint as scheduled updates: minimize writes unless inputs affecting delivery actually changed
	============= */
	const needsDailyNextSendAtRepair =
		hasDailyTime &&
		dbUser.daily_next_send_at === null &&
		safeNotificationPreferenceUpdates.daily_next_send_at === undefined;

	if (
		(timezoneChanged || dailyTimeChanged || needsDailyNextSendAtRepair) &&
		hasDailyTime
	) {
		const nextDailyUtc = calculateNextSendAt(
			finalDailyTime,
			finalTimezone,
			DateTime.utc(),
		);
		safeNotificationPreferenceUpdates.daily_next_send_at =
			nextDailyUtc?.toISO() ?? null;
	} else if (dailyTimeChanged && !hasDailyTime) {
		safeNotificationPreferenceUpdates.daily_next_send_at = null;
	}

	/* =============
	Weekly calendar: compute weekly_next_send_at when weekly options or timezone change
	============= */
	const finalWeeklyEarnings =
		safeNotificationPreferenceUpdates.weekly_include_earnings ??
		dbUser.weekly_include_earnings;
	const finalWeeklyDividends =
		safeNotificationPreferenceUpdates.weekly_include_dividends ??
		dbUser.weekly_include_dividends;
	const hasAnyWeeklyOption = finalWeeklyEarnings || finalWeeklyDividends;

	const weeklyOptionsChanged =
		safeNotificationPreferenceUpdates.weekly_include_earnings !== undefined ||
		safeNotificationPreferenceUpdates.weekly_include_dividends !== undefined;

	const needsWeeklyNextSendAtRepair =
		hasAnyWeeklyOption &&
		dbUser.weekly_next_send_at === null &&
		safeNotificationPreferenceUpdates.weekly_next_send_at === undefined;

	if (
		(timezoneChanged ||
			dailyTimeChanged ||
			weeklyOptionsChanged ||
			needsWeeklyNextSendAtRepair) &&
		hasAnyWeeklyOption
	) {
		const nextWeeklyUtc = calculateNextMondaySendAt(
			finalDailyTime,
			finalTimezone,
			DateTime.utc(),
		);
		safeNotificationPreferenceUpdates.weekly_next_send_at =
			nextWeeklyUtc?.toISO() ?? null;
	} else if (weeklyOptionsChanged && !hasAnyWeeklyOption) {
		safeNotificationPreferenceUpdates.weekly_next_send_at = null;
	}

	return safeNotificationPreferenceUpdates;
}

export interface TimezoneUpdatePayload {
	timezone: string;
	next_send_at?: string | null;
	daily_next_send_at?: string | null;
	weekly_next_send_at?: string | null;
}

export function computeTimezoneUpdatePayload(
	newTimezone: string,
	dbUser: User,
	logger?: Logger,
): TimezoneUpdatePayload {
	const payload: TimezoneUpdatePayload = {
		timezone: newTimezone,
	};

	if (newTimezone === dbUser.timezone) {
		return payload;
	}

	/* =============
	No schedule: timezone changes don't require recomputing next_send_at
	============= */
	if (
		dbUser.scheduled_update_times &&
		dbUser.scheduled_update_times.length > 0
	) {
		payload.next_send_at = computeNextSendAtIso(
			dbUser.scheduled_update_times,
			newTimezone,
			{
				userId: dbUser.id,
				timezone: newTimezone,
				timesCount: dbUser.scheduled_update_times.length,
			},
			logger,
		);
	}

	if (dbUser.daily_delivery_time != null) {
		const nextDailyUtc = calculateNextSendAt(
			dbUser.daily_delivery_time,
			newTimezone,
			DateTime.utc(),
		);
		payload.daily_next_send_at = nextDailyUtc?.toISO() ?? null;
	}

	if (dbUser.weekly_include_earnings || dbUser.weekly_include_dividends) {
		const nextWeeklyUtc = calculateNextMondaySendAt(
			dbUser.daily_delivery_time,
			newTimezone,
			DateTime.utc(),
		);
		payload.weekly_next_send_at = nextWeeklyUtc?.toISO() ?? null;
	}

	return payload;
}
