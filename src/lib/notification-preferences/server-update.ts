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
	daily_include_news_email?: boolean;
	daily_include_rumors_email?: boolean;
	daily_include_analyst_email?: boolean;
	daily_include_insider_email?: boolean;
	daily_include_analyst_sms?: boolean;
	daily_include_insider_sms?: boolean;
	price_include_email?: boolean;
	price_include_sms?: boolean;
	weekly_include_earnings_email?: boolean;
	weekly_include_earnings_sms?: boolean;
	weekly_include_dividends_email?: boolean;
	weekly_include_dividends_sms?: boolean;
}

function computeScheduledNextSendAt(
	updates: UserUpdateInput,
	dbUser: User,
	finalTimezone: string,
	finalTimes: number[] | null,
	timezoneChanged: boolean,
	timeChanged: boolean,
	logger?: Logger,
): void {
	const hasTimes = finalTimes !== null && finalTimes.length > 0;
	const needsRepair =
		hasTimes &&
		dbUser.next_send_at === null &&
		updates.next_send_at === undefined;

	if ((timezoneChanged || timeChanged || needsRepair) && hasTimes) {
		updates.next_send_at = computeNextSendAtIso(
			finalTimes,
			finalTimezone,
			{ userId: dbUser.id, finalTimes, finalTimezone },
			logger,
		);
	} else if (timeChanged && !hasTimes) {
		updates.next_send_at = null;
	}
}

function computeDailyNextSendAt(
	updates: UserUpdateInput,
	dbUser: User,
	finalDailyTime: number | null,
	finalTimezone: string,
	timezoneChanged: boolean,
	dailyTimeChanged: boolean,
): void {
	const hasDailyTime = finalDailyTime !== null;
	const needsRepair =
		hasDailyTime &&
		dbUser.daily_next_send_at === null &&
		updates.daily_next_send_at === undefined;

	if ((timezoneChanged || dailyTimeChanged || needsRepair) && hasDailyTime) {
		const nextDailyUtc = calculateNextSendAt(
			finalDailyTime,
			finalTimezone,
			DateTime.utc(),
		);
		updates.daily_next_send_at = nextDailyUtc?.toISO() ?? null;
	} else if (dailyTimeChanged && !hasDailyTime) {
		updates.daily_next_send_at = null;
	}
}

function computeWeeklyNextSendAt(
	updates: UserUpdateInput,
	dbUser: User,
	finalDailyTime: number | null,
	finalTimezone: string,
	timezoneChanged: boolean,
	dailyTimeChanged: boolean,
	weeklyOptionsChanged: boolean,
): void {
	const finalWeeklyEarningsEmail =
		updates.weekly_include_earnings_email ??
		dbUser.weekly_include_earnings_email;
	const finalWeeklyEarningsSms =
		updates.weekly_include_earnings_sms ?? dbUser.weekly_include_earnings_sms;
	const finalWeeklyDividendsEmail =
		updates.weekly_include_dividends_email ??
		dbUser.weekly_include_dividends_email;
	const finalWeeklyDividendsSms =
		updates.weekly_include_dividends_sms ?? dbUser.weekly_include_dividends_sms;
	const hasAnyWeeklyOption =
		finalWeeklyEarningsEmail ||
		finalWeeklyEarningsSms ||
		finalWeeklyDividendsEmail ||
		finalWeeklyDividendsSms;

	const needsRepair =
		hasAnyWeeklyOption &&
		dbUser.weekly_next_send_at === null &&
		updates.weekly_next_send_at === undefined;

	if (
		(timezoneChanged ||
			dailyTimeChanged ||
			weeklyOptionsChanged ||
			needsRepair) &&
		hasAnyWeeklyOption
	) {
		const nextWeeklyUtc = calculateNextMondaySendAt(
			finalDailyTime,
			finalTimezone,
			DateTime.utc(),
		);
		updates.weekly_next_send_at = nextWeeklyUtc?.toISO() ?? null;
	} else if (weeklyOptionsChanged && !hasAnyWeeklyOption) {
		updates.weekly_next_send_at = null;
	}
}

/**
 * Build a safe `users` table update payload from the notification preferences form submission.
 *
 * Only fields actually submitted by the form are persisted to avoid boolean drift when unchecked
 * controls are omitted. Also recomputes derived `*_next_send_at` fields when inputs change.
 */
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
	Only persist booleans the form actually submitted (unchecked controls are often omitted).
	Build imperatively to avoid a union-type explosion from too many spread expressions.
	============= */
	const boolFields = [
		["price_notifications_enabled", true],
		["price_include_email", false],
		["price_include_sms", false],
		["daily_include_news_email", false],
		["daily_include_rumors_email", false],
		["daily_include_analyst_email", false],
		["daily_include_insider_email", false],
		["daily_include_analyst_sms", false],
		["daily_include_insider_sms", false],
		["weekly_include_earnings_email", false],
		["weekly_include_earnings_sms", false],
		["weekly_include_dividends_email", false],
		["weekly_include_dividends_sms", false],
		["email_notifications_enabled", false],
		["sms_notifications_enabled", false],
		["only_notify_when_market_open", false],
		["daily_only_notify_when_market_open", false],
	] as const satisfies ReadonlyArray<
		readonly [keyof ParsedNotificationPreferencesForm, boolean]
	>;

	const boolUpdates: Record<string, boolean> = {};
	for (const [field, fallback] of boolFields) {
		if (formData.has(field)) {
			boolUpdates[field] =
				(parsedData[field] as boolean | undefined) ?? fallback;
		}
	}

	const safeNotificationPreferenceUpdates: UserUpdateInput = omitUndefined({
		timezone: parsedData.timezone,
		scheduled_update_times: normalizedTimes,
		...boolUpdates,
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

	const finalDailyTime =
		safeNotificationPreferenceUpdates.daily_delivery_time !== undefined
			? safeNotificationPreferenceUpdates.daily_delivery_time
			: dbUser.daily_delivery_time;

	const weeklyOptionsChanged =
		safeNotificationPreferenceUpdates.weekly_include_earnings_email !==
			undefined ||
		safeNotificationPreferenceUpdates.weekly_include_earnings_sms !==
			undefined ||
		safeNotificationPreferenceUpdates.weekly_include_dividends_email !==
			undefined ||
		safeNotificationPreferenceUpdates.weekly_include_dividends_sms !==
			undefined;

	computeScheduledNextSendAt(
		safeNotificationPreferenceUpdates,
		dbUser,
		finalTimezone,
		finalTimes,
		timezoneChanged,
		timeChanged,
		logger,
	);
	computeDailyNextSendAt(
		safeNotificationPreferenceUpdates,
		dbUser,
		finalDailyTime,
		finalTimezone,
		timezoneChanged,
		dailyTimeChanged,
	);
	computeWeeklyNextSendAt(
		safeNotificationPreferenceUpdates,
		dbUser,
		finalDailyTime,
		finalTimezone,
		timezoneChanged,
		dailyTimeChanged,
		weeklyOptionsChanged,
	);

	return safeNotificationPreferenceUpdates;
}

export interface TimezoneUpdatePayload {
	timezone: string;
	next_send_at?: string | null;
	daily_next_send_at?: string | null;
	weekly_next_send_at?: string | null;
}

/**
 * Compute the minimal update payload required when a user changes timezone.
 *
 * Recomputes `next_send_at`, `daily_next_send_at`, and `weekly_next_send_at` only when the user
 * has the corresponding schedule enabled to avoid unnecessary writes.
 */
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

	if (
		dbUser.weekly_include_earnings_email ||
		dbUser.weekly_include_earnings_sms ||
		dbUser.weekly_include_dividends_email ||
		dbUser.weekly_include_dividends_sms
	) {
		const nextWeeklyUtc = calculateNextMondaySendAt(
			dbUser.daily_delivery_time,
			newTimezone,
			DateTime.utc(),
		);
		payload.weekly_next_send_at = nextWeeklyUtc?.toISO() ?? null;
	}

	return payload;
}
