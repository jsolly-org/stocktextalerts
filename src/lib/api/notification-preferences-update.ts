import { DateTime } from "luxon";
import { computeAssetEventsNextSendAt } from "../asset-events/scheduling-helpers";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
import { userLocalToEtMinute } from "../time/format";
import {
	calculateNextSendAt,
	computeNextSendAtIso,
	parseScheduledTimes,
	serializeTimes,
} from "../time/scheduled-times";

/** Parsed form fields the update endpoint consumes. Per-option channel fields
 *  (`*_email`/`*_sms`/`*_telegram`) are persisted to notification_preferences by
 *  `persistChannelPreferences`; the KEPT fields below are written to `users`. The
 *  asset_events `*_email`/`*_sms` fields are read here only to recompute
 *  `asset_events_next_send_at`. */
interface ParsedNotificationPreferencesForm {
	market_scheduled_asset_price_enabled?: boolean;
	timezone?: string;
	email_notifications_enabled?: boolean;
	sms_notifications_enabled?: boolean;
	market_scheduled_asset_price_times?: string[];
	daily_digest_time?: number;
	market_asset_price_alerts_enabled?: boolean;
	market_asset_price_alert_move_size?: "significant" | "extreme";
	// asset_events per-option fields (used only for next-send-at scheduling here;
	// persisted to the table by persistChannelPreferences).
	asset_events_include_calendar_email?: boolean;
	asset_events_include_calendar_sms?: boolean;
	asset_events_include_ipo_email?: boolean;
	asset_events_include_ipo_sms?: boolean;
	asset_events_include_analyst_email?: boolean;
	asset_events_include_analyst_sms?: boolean;
	asset_events_include_insider_email?: boolean;
	asset_events_include_insider_sms?: boolean;
}

/** asset_events form fields that gate `asset_events_next_send_at` scheduling. */
export const ASSET_EVENTS_SCHEDULE_FIELDS = [
	"asset_events_include_calendar_email",
	"asset_events_include_calendar_sms",
	"asset_events_include_ipo_email",
	"asset_events_include_ipo_sms",
	"asset_events_include_analyst_email",
	"asset_events_include_analyst_sms",
	"asset_events_include_insider_email",
	"asset_events_include_insider_sms",
] as const satisfies ReadonlyArray<keyof ParsedNotificationPreferencesForm>;

/**
 * Compute `market_scheduled_asset_price_next_send_at` for scheduled update notifications when timezone or schedule changes.
 *
 * Mutates `updates` in-place so callers can compose a single `users` table update payload.
 * Times are ET-canonical minutes; timezone is informational context only.
 */
function computeScheduledNextSendAt(
	updates: UserUpdateInput,
	dbUser: User,
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
			{ userId: dbUser.id, finalTimes },
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
		const etMinutes = userLocalToEtMinute(finalDailyTime, finalTimezone);
		const nextDailyUtc = calculateNextSendAt(etMinutes, DateTime.utc());
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
	/** Whether the user has ANY asset-events email/sms facet enabled AFTER this
	 *  update (merged: existing table rows + submitted overrides), resolved by the
	 *  caller. Drives `asset_events_next_send_at`. */
	assetEventsEnabledAfterUpdate: boolean;
	/** Whether any asset-events email/sms facet's value changed in this submission. */
	assetEventsOptionsChanged: boolean;
	logger?: Logger;
}): UserUpdateInput {
	const {
		parsedData,
		formData,
		rawTimesValue,
		parsedMarketScheduledAssetPriceTimes,
		dbUser,
		assetEventsEnabledAfterUpdate,
		assetEventsOptionsChanged,
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
	Form supplies user-local minutes; storage is ET-canonical. Convert at the
	API boundary so downstream code (cron, formatters) treats stored values
	as ET-minutes uniformly. Apply unique+sort after conversion since two
	distinct local minutes can collapse to the same ET minute (e.g. across
	timezones with sub-hour offsets) — though the common case is a 1:1 map.
	============= */
	const formTimezone = parsedData.timezone ?? dbUser.timezone;
	let etNormalizedTimes: number[] | null | undefined = normalizedTimes;
	if (Array.isArray(normalizedTimes) && normalizedTimes.length > 0) {
		const converted = normalizedTimes.map((localMin) =>
			userLocalToEtMinute(localMin, formTimezone),
		);
		etNormalizedTimes = [...new Set(converted)].sort((a, b) => a - b);
	}

	/* =============
	Only persist booleans the form actually submitted (unchecked controls are often omitted).
	Per-option channel facets live in notification_preferences (written separately by
	persistChannelPreferences); only KEPT channel/feature-level booleans go to `users`.
	============= */
	const boolFields = [
		"market_scheduled_asset_price_enabled",
		"email_notifications_enabled",
		"sms_notifications_enabled",
		"market_asset_price_alerts_enabled",
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
		market_scheduled_asset_price_times: etNormalizedTimes,
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

	computeScheduledNextSendAt(
		safeNotificationPreferenceUpdates,
		dbUser,
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
		assetEventsEnabledAfterUpdate,
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
	/** Whether the user has any asset-events email/sms facet enabled (from
	 *  notification_preferences), used to decide whether to recompute its schedule. */
	hasAnyAssetEvents: boolean,
): TimezoneUpdatePayload {
	const payload: TimezoneUpdatePayload = {
		timezone: newTimezone,
	};

	if (newTimezone === dbUser.timezone) {
		return payload;
	}

	// Market scheduled times are ET-canonical; the absolute UTC moment of
	// next_send_at is invariant under user-timezone changes. The stored
	// ISO is still correct, so don't recompute / write it.
	// (Spec: "stored values are ET-minutes — invariant under timezone
	// changes... the call site drops the newTimezone argument.")

	if (dbUser.daily_digest_time != null) {
		const etMinutes = userLocalToEtMinute(dbUser.daily_digest_time, newTimezone);
		const nextDailyUtc = calculateNextSendAt(etMinutes, DateTime.utc());
		payload.daily_digest_next_send_at = nextDailyUtc?.toISO() ?? null;
	}

	if (hasAnyAssetEvents) {
		const baseLocal = dbUser.daily_digest_time ?? 540;
		const etMinutes = userLocalToEtMinute(baseLocal, newTimezone);
		const nextUtc = calculateNextSendAt(etMinutes, DateTime.utc());
		payload.asset_events_next_send_at = nextUtc?.toISO() ?? null;
	}

	return payload;
}
