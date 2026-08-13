import type {
	DeliveryChannelMode,
	FacetCatalogEntry,
	NotificationOptionFieldName,
} from "../constants";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../constants";
import { applyDailyNotificationNextSendAtToUserUpdate } from "../daily-notification/schedule";
import { omitUndefined } from "../db";
import type { User, UserUpdateInput } from "../db/types";
import type { Logger } from "../logging";
import { getUsBeforeOpenLocalMinutes, userLocalToEtMinute } from "../time/conversion";
import {
	computeNextSendAtIso,
	parseScheduledTimes,
	serializeTimes,
} from "../time/schedule/next-send";

/** Parsed form fields the update endpoint consumes. Per-option content fields
 *  (derived from the catalog) are persisted to notification_preferences by
 *  `persistNotificationPreferences`; account routing + schedule fields go to `users`.
 *  Daily-notification option fields are read here only to recompute
 *  `daily_notification_next_send_at`. */
type ParsedNotificationPreferencesForm = {
	market_scheduled_asset_price_enabled?: boolean;
	timezone?: string;
	delivery_channel?: DeliveryChannelMode;
	market_scheduled_asset_price_times?: string[];
	daily_digest_time?: number;
	daily_notification_enabled?: boolean;
} & Partial<Record<NotificationOptionFieldName, boolean>>;

/** Catalog entries for every daily_notification option (schedule source of truth). */
export const DAILY_NOTIFICATION_CATALOG_ENTRIES: readonly FacetCatalogEntry[] =
	NOTIFICATION_PREFERENCE_CATALOG.filter(
		(entry) => entry.notification_type === "daily_notification",
	);

/** Daily notification form fields that gate next-send-at scheduling. */
export const DAILY_NOTIFICATION_SCHEDULE_FIELDS: readonly NotificationOptionFieldName[] =
	DAILY_NOTIFICATION_CATALOG_ENTRIES.map((entry) => entry.fieldName);

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
	/** Whether the user has ANY daily notification facet enabled AFTER this update. */
	dailyNotificationEnabledAfterUpdate: boolean;
	/** Whether any daily notification facet changed in this submission. */
	dailyNotificationOptionsChanged: boolean;
	logger?: Logger;
}): UserUpdateInput {
	const {
		parsedData,
		formData,
		rawTimesValue,
		parsedMarketScheduledAssetPriceTimes,
		dbUser,
		dailyNotificationEnabledAfterUpdate,
		dailyNotificationOptionsChanged,
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
	Content toggles live in notification_preferences (written separately by
	persistNotificationPreferences); schedule + delivery_channel go to `users`.
	============= */
	const boolFields = [
		"market_scheduled_asset_price_enabled",
		"daily_notification_enabled",
	] as const satisfies ReadonlyArray<keyof ParsedNotificationPreferencesForm>;

	const boolUpdates: Record<string, boolean> = {};
	for (const field of boolFields) {
		const val = parsedData[field] as boolean | undefined;
		if (formData.has(field) && val !== undefined) {
			boolUpdates[field] = val;
		}
	}

	const safeNotificationPreferenceUpdates = omitUndefined({
		timezone: parsedData.timezone,
		market_scheduled_asset_price_times: etNormalizedTimes,
		...boolUpdates,
		...(formData.has("delivery_channel") && parsedData.delivery_channel !== undefined
			? { delivery_channel: parsedData.delivery_channel }
			: {}),
	}) as UserUpdateInput;

	const finalTimezone = safeNotificationPreferenceUpdates.timezone ?? dbUser.timezone;
	const lockedDailyTime = getUsBeforeOpenLocalMinutes(finalTimezone);
	safeNotificationPreferenceUpdates.daily_notification_time = lockedDailyTime;

	const timezoneChanged =
		safeNotificationPreferenceUpdates.timezone !== undefined &&
		safeNotificationPreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safeNotificationPreferenceUpdates.market_scheduled_asset_price_times !== undefined &&
		serializeTimes(safeNotificationPreferenceUpdates.market_scheduled_asset_price_times) !==
			serializeTimes(dbUser.market_scheduled_asset_price_times ?? null);

	const dailyTimeChanged = lockedDailyTime !== dbUser.daily_notification_time;

	const finalTimes =
		safeNotificationPreferenceUpdates.market_scheduled_asset_price_times !== undefined
			? safeNotificationPreferenceUpdates.market_scheduled_asset_price_times
			: dbUser.market_scheduled_asset_price_times;

	computeScheduledNextSendAt(
		safeNotificationPreferenceUpdates,
		dbUser,
		finalTimes,
		timezoneChanged,
		timeChanged,
		logger,
	);
	applyDailyNotificationNextSendAtToUserUpdate({
		updates: safeNotificationPreferenceUpdates,
		dbUser,
		timezoneChanged,
		dailyTimeChanged,
		dailyOptionsChanged: dailyNotificationOptionsChanged,
		hasDailyNotification: dailyNotificationEnabledAfterUpdate,
	});

	return safeNotificationPreferenceUpdates;
}

interface TimezoneUpdatePayload {
	timezone: string;
	daily_notification_time?: number;
	daily_notification_next_send_at?: string | null;
}

/**
 * Compute the minimal update payload required when a user changes timezone.
 *
 * Recomputes `daily_notification_next_send_at` only when the user has daily
 * notification enabled. Market scheduled times are ET-canonical and do not
 * need timezone-driven recomputation.
 */
export function computeTimezoneUpdatePayload(
	newTimezone: string,
	dbUser: User,
	hasDailyNotification: boolean,
): TimezoneUpdatePayload {
	const payload: TimezoneUpdatePayload = {
		timezone: newTimezone,
	};

	if (newTimezone === dbUser.timezone) {
		return payload;
	}

	const lockedDailyTime = getUsBeforeOpenLocalMinutes(newTimezone);
	payload.daily_notification_time = lockedDailyTime;

	if (hasDailyNotification) {
		const tempUpdates: Record<string, unknown> = {};
		applyDailyNotificationNextSendAtToUserUpdate({
			updates: tempUpdates,
			dbUser,
			timezoneChanged: true,
			dailyTimeChanged: lockedDailyTime !== dbUser.daily_notification_time,
			dailyOptionsChanged: false,
			hasDailyNotification: true,
		});
		payload.daily_notification_next_send_at =
			(tempUpdates.daily_notification_next_send_at as string | null | undefined) ?? null;
	}

	return payload;
}
