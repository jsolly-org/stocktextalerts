import { DateTime } from "luxon";
import {
	ASSET_EVENTS_OPTION_FIELDS,
	computeAssetEventsNextSendAt,
} from "../asset-events/scheduling-helpers";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
import {
	calculateNextSendAt,
	computeNextSendAtIso,
	parseScheduledTimes,
	serializeTimes,
} from "../time/scheduled-times";

interface ParsedNotificationPreferencesForm {
	market_scheduled_asset_price_enabled?: boolean;
	timezone?: string;
	email_notifications_enabled?: boolean;
	sms_notifications_enabled?: boolean;
	market_scheduled_asset_price_times?: string[];
	daily_digest_time?: number;
	daily_digest_include_prices_email?: boolean;
	daily_digest_include_prices_sms?: boolean;
	daily_digest_include_top_movers_email?: boolean;
	daily_digest_include_top_movers_sms?: boolean;
	daily_digest_include_news_email?: boolean;
	daily_digest_include_rumors_email?: boolean;
	market_scheduled_asset_price_include_email?: boolean;
	market_scheduled_asset_price_include_sms?: boolean;
	asset_events_include_calendar_email?: boolean;
	asset_events_include_calendar_sms?: boolean;
	asset_events_include_ipo_email?: boolean;
	asset_events_include_ipo_sms?: boolean;
	asset_events_include_analyst_email?: boolean;
	asset_events_include_analyst_sms?: boolean;
	asset_events_include_insider_email?: boolean;
	asset_events_include_insider_sms?: boolean;
	market_asset_price_alerts_enabled?: boolean;
	market_asset_price_alerts_include_email?: boolean;
	market_asset_price_alerts_include_sms?: boolean;
	market_asset_price_alert_move_size?: "significant" | "extreme";
	price_move_alerts_include_email?: boolean;
	price_move_alerts_include_sms?: boolean;
	price_targets_include_email?: boolean;
	price_targets_include_sms?: boolean;
}

/**
 * Compute `market_scheduled_asset_price_next_send_at` for scheduled update notifications when timezone or schedule changes.
 *
 * Mutates `updates` in-place so callers can compose a single `users` table update payload.
 */
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
		dbUser.market_scheduled_asset_price_next_send_at === null &&
		updates.market_scheduled_asset_price_next_send_at === undefined;

	if ((timezoneChanged || timeChanged || needsRepair) && hasTimes) {
		updates.market_scheduled_asset_price_next_send_at = computeNextSendAtIso(
			finalTimes,
			finalTimezone,
			{ userId: dbUser.id, finalTimes, finalTimezone },
			logger,
		);
	} else if (timeChanged && !hasTimes) {
		updates.market_scheduled_asset_price_next_send_at = null;
	}
}

/**
 * Compute `daily_digest_next_send_at` when the daily delivery time or timezone changes.
 *
 * Mutates `updates` in-place so callers can compose a single `users` table update payload.
 */
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
		dbUser.daily_digest_next_send_at === null &&
		updates.daily_digest_next_send_at === undefined;

	if ((timezoneChanged || dailyTimeChanged || needsRepair) && hasDailyTime) {
		const nextDailyUtc = calculateNextSendAt(finalDailyTime, finalTimezone, DateTime.utc());
		updates.daily_digest_next_send_at = nextDailyUtc?.toISO() ?? null;
	} else if (dailyTimeChanged && !hasDailyTime) {
		updates.daily_digest_next_send_at = null;
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
	parsedMarketScheduledAssetPriceTimes?: number[] | null;
	dbUser: User;
	logger?: Logger;
}): UserUpdateInput {
	const {
		parsedData,
		formData,
		rawTimesValue,
		parsedMarketScheduledAssetPriceTimes,
		dbUser,
		logger,
	} = options;

	let parsedTimes: number[] | null | undefined;
	if (rawTimesValue === "") {
		parsedTimes = [];
	} else if (parsedData.market_scheduled_asset_price_times !== undefined) {
		if (parsedMarketScheduledAssetPriceTimes !== undefined) {
			parsedTimes = parsedMarketScheduledAssetPriceTimes;
		} else {
			const result = parseScheduledTimes(parsedData.market_scheduled_asset_price_times);
			if (!result.ok) {
				logger?.info("Invalid scheduled times in notification preferences payload", {
					action: "notification_preferences_update",
					userId: dbUser.id,
					reason: result.reason,
				});
				throw new Error(`Invalid schedule: ${result.reason}`);
			}
			parsedTimes = result.times;
		}
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
		"market_scheduled_asset_price_enabled",
		"market_scheduled_asset_price_include_email",
		"market_scheduled_asset_price_include_sms",
		"daily_digest_include_prices_email",
		"daily_digest_include_prices_sms",
		"daily_digest_include_top_movers_email",
		"daily_digest_include_top_movers_sms",
		"daily_digest_include_news_email",
		"daily_digest_include_rumors_email",
		"asset_events_include_calendar_email",
		"asset_events_include_calendar_sms",
		"asset_events_include_ipo_email",
		"asset_events_include_ipo_sms",
		"asset_events_include_analyst_email",
		"asset_events_include_analyst_sms",
		"asset_events_include_insider_email",
		"asset_events_include_insider_sms",
		"email_notifications_enabled",
		"sms_notifications_enabled",
		"market_asset_price_alerts_enabled",
		"market_asset_price_alerts_include_email",
		"market_asset_price_alerts_include_sms",
		"price_move_alerts_include_email",
		"price_move_alerts_include_sms",
		"price_targets_include_email",
		"price_targets_include_sms",
	] as const satisfies ReadonlyArray<keyof ParsedNotificationPreferencesForm>;

	const boolUpdates: Record<string, boolean> = {};
	for (const field of boolFields) {
		const val = parsedData[field] as boolean | undefined;
		if (formData.has(field) && val !== undefined) {
			boolUpdates[field] = val;
		}
	}

	const safeNotificationPreferenceUpdates: UserUpdateInput = omitUndefined({
		timezone: parsedData.timezone,
		market_scheduled_asset_price_times: normalizedTimes,
		...boolUpdates,
		...(formData.has("daily_digest_time")
			? { daily_digest_time: parsedData.daily_digest_time ?? null }
			: {}),
		...(formData.has("market_asset_price_alert_move_size") &&
		parsedData.market_asset_price_alert_move_size !== undefined
			? {
					market_asset_price_alert_move_size: parsedData.market_asset_price_alert_move_size,
				}
			: {}),
	});

	const timezoneChanged =
		safeNotificationPreferenceUpdates.timezone !== undefined &&
		safeNotificationPreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safeNotificationPreferenceUpdates.market_scheduled_asset_price_times !== undefined &&
		serializeTimes(safeNotificationPreferenceUpdates.market_scheduled_asset_price_times) !==
			serializeTimes(dbUser.market_scheduled_asset_price_times ?? null);

	const dailyTimeChanged =
		safeNotificationPreferenceUpdates.daily_digest_time !== undefined &&
		safeNotificationPreferenceUpdates.daily_digest_time !== dbUser.daily_digest_time;

	const finalTimezone = safeNotificationPreferenceUpdates.timezone ?? dbUser.timezone;
	const finalTimes =
		safeNotificationPreferenceUpdates.market_scheduled_asset_price_times !== undefined
			? safeNotificationPreferenceUpdates.market_scheduled_asset_price_times
			: dbUser.market_scheduled_asset_price_times;

	const finalDailyTime =
		safeNotificationPreferenceUpdates.daily_digest_time !== undefined
			? safeNotificationPreferenceUpdates.daily_digest_time
			: dbUser.daily_digest_time;

	const assetEventsOptionsChanged = ASSET_EVENTS_OPTION_FIELDS.some(
		(field) =>
			safeNotificationPreferenceUpdates[field as keyof typeof safeNotificationPreferenceUpdates] !==
			undefined,
	);

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
	computeAssetEventsNextSendAt(
		safeNotificationPreferenceUpdates,
		dbUser,
		finalDailyTime,
		finalTimezone,
		timezoneChanged,
		dailyTimeChanged,
		assetEventsOptionsChanged,
	);

	return safeNotificationPreferenceUpdates;
}

interface TimezoneUpdatePayload {
	timezone: string;
	market_scheduled_asset_price_next_send_at?: string | null;
	daily_digest_next_send_at?: string | null;
	asset_events_next_send_at?: string | null;
}

/**
 * Compute the minimal update payload required when a user changes timezone.
 *
 * Recomputes `market_scheduled_asset_price_next_send_at`, `daily_digest_next_send_at`, and `asset_events_next_send_at` only when the user
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
	No schedule: timezone changes don't require recomputing market_scheduled_asset_price_next_send_at
	============= */
	if (
		dbUser.market_scheduled_asset_price_times &&
		dbUser.market_scheduled_asset_price_times.length > 0
	) {
		payload.market_scheduled_asset_price_next_send_at = computeNextSendAtIso(
			dbUser.market_scheduled_asset_price_times,
			newTimezone,
			{
				userId: dbUser.id,
				timezone: newTimezone,
				timesCount: dbUser.market_scheduled_asset_price_times.length,
			},
			logger,
		);
	}

	if (dbUser.daily_digest_time != null) {
		const nextDailyUtc = calculateNextSendAt(dbUser.daily_digest_time, newTimezone, DateTime.utc());
		payload.daily_digest_next_send_at = nextDailyUtc?.toISO() ?? null;
	}

	const hasAnyAssetEvents = ASSET_EVENTS_OPTION_FIELDS.some(
		(field) => dbUser[field as keyof typeof dbUser],
	);
	if (hasAnyAssetEvents) {
		const nextUtc = calculateNextSendAt(
			dbUser.daily_digest_time ?? 540,
			newTimezone,
			DateTime.utc(),
		);
		payload.asset_events_next_send_at = nextUtc?.toISO() ?? null;
	}

	return payload;
}
