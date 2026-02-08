import { DateTime } from "luxon";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
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
	add_ons_only_notify_when_market_open?: boolean;
	add_ons_delivery_time?: number;
	first_notification_include_news?: boolean;
	first_notification_include_rumors?: boolean;
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

	// Only include a boolean field when it was present in the submitted form.
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
		...boolFromForm("first_notification_include_news"),
		...boolFromForm("first_notification_include_rumors"),
		...boolFromForm("email_notifications_enabled"),
		...boolFromForm("sms_notifications_enabled"),
		...boolFromForm("only_notify_when_market_open"),
		...boolFromForm("add_ons_only_notify_when_market_open"),
		...(formData.has("add_ons_delivery_time")
			? { add_ons_delivery_time: parsedData.add_ons_delivery_time ?? null }
			: {}),
	});

	const timezoneChanged =
		safeNotificationPreferenceUpdates.timezone !== undefined &&
		safeNotificationPreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safeNotificationPreferenceUpdates.scheduled_update_times !== undefined &&
		serializeTimes(safeNotificationPreferenceUpdates.scheduled_update_times) !==
			serializeTimes(dbUser.scheduled_update_times ?? null);

	const addOnsTimeChanged =
		safeNotificationPreferenceUpdates.add_ons_delivery_time !== undefined &&
		safeNotificationPreferenceUpdates.add_ons_delivery_time !==
			dbUser.add_ons_delivery_time;

	const finalTimezone =
		safeNotificationPreferenceUpdates.timezone ?? dbUser.timezone;
	const finalTimes =
		safeNotificationPreferenceUpdates.scheduled_update_times !== undefined
			? safeNotificationPreferenceUpdates.scheduled_update_times
			: dbUser.scheduled_update_times;
	// "Enabled" is derived: has times = enabled
	const hasTimes = finalTimes !== null && finalTimes.length > 0;

	const finalAddOnsTime =
		safeNotificationPreferenceUpdates.add_ons_delivery_time !== undefined
			? safeNotificationPreferenceUpdates.add_ons_delivery_time
			: dbUser.add_ons_delivery_time;
	// "Enabled" is derived: has delivery time = enabled
	const hasAddOnsTime = finalAddOnsTime !== null;

	// Self-heal: if user has times but next_send_at is missing, recompute.
	const needsNextSendAtRepair =
		hasTimes &&
		dbUser.next_send_at === null &&
		safeNotificationPreferenceUpdates.next_send_at === undefined;

	/* ============= Scheduled updates next_send_at ============= */
	if ((timezoneChanged || timeChanged || needsNextSendAtRepair) && hasTimes) {
		safeNotificationPreferenceUpdates.next_send_at = computeNextSendAtIso(
			finalTimes,
			finalTimezone,
			{ userId: dbUser.id, finalTimes, finalTimezone },
			logger,
		);
	} else if (timeChanged && !hasTimes) {
		// User removed all times — clear schedule
		safeNotificationPreferenceUpdates.next_send_at = null;
	}

	/* ============= Add-ons next_send_at ============= */
	const needsAddOnsNextSendAtRepair =
		hasAddOnsTime &&
		dbUser.add_ons_next_send_at === null &&
		safeNotificationPreferenceUpdates.add_ons_next_send_at === undefined;

	if (
		(timezoneChanged || addOnsTimeChanged || needsAddOnsNextSendAtRepair) &&
		hasAddOnsTime
	) {
		const nextAddOnsUtc = calculateNextSendAt(
			finalAddOnsTime,
			finalTimezone,
			DateTime.utc(),
		);
		safeNotificationPreferenceUpdates.add_ons_next_send_at =
			nextAddOnsUtc?.toISO() ?? null;
	} else if (addOnsTimeChanged && !hasAddOnsTime) {
		safeNotificationPreferenceUpdates.add_ons_next_send_at = null;
	}

	return safeNotificationPreferenceUpdates;
}

export interface TimezoneUpdatePayload {
	timezone: string;
	next_send_at?: string | null;
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

	// No times — nothing to recompute
	if (
		!dbUser.scheduled_update_times ||
		dbUser.scheduled_update_times.length === 0
	) {
		return payload;
	}

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

	return payload;
}
