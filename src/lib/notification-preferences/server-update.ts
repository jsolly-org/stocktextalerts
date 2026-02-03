import { DateTime } from "luxon";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
import { calculateNextSendAtFromTimes } from "../time/digest-times";
import { parseTimeToMinutes } from "../time/format";

export type DigestTimesParseResult =
	| { ok: true; times: number[] }
	| { ok: false; reason: string };

export function parseDigestTimes(values: string[]): DigestTimesParseResult {
	const minutes: number[] = [];
	for (const value of values) {
		const parsed = parseTimeToMinutes(value);
		if (parsed === null) {
			return { ok: false, reason: "invalid_time" };
		}
		if (parsed % 15 !== 0) {
			return { ok: false, reason: "invalid_time_increment" };
		}
		minutes.push(parsed);
	}

	const unique = [...new Set(minutes)].sort((a, b) => a - b);
	return { ok: true, times: unique };
}

function serializeTimes(times: number[] | null | undefined): string {
	if (!times || times.length === 0) {
		return "";
	}
	return [...times].sort((a, b) => a - b).join(",");
}

export interface ParsedNotificationPreferencesForm {
	timezone?: string;
	email_notifications_enabled?: boolean;
	sms_notifications_enabled?: boolean;
	daily_digest_enabled?: boolean;
	daily_digest_notification_times?: string[];
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
	} else if (parsedData.daily_digest_notification_times !== undefined) {
		const result = parseDigestTimes(parsedData.daily_digest_notification_times);
		if (!result.ok) {
			// Caller should have validated; treat as empty
			parsedTimes = [];
		} else {
			parsedTimes = result.times;
		}
	} else {
		parsedTimes = undefined;
	}

	let normalizedTimes: number[] | null | undefined = parsedTimes;
	if (normalizedTimes && normalizedTimes.length === 0) {
		normalizedTimes = null;
	}

	const safeNotificationPreferenceUpdates: UserUpdateInput = omitUndefined({
		timezone: parsedData.timezone,
		daily_digest_notification_times: normalizedTimes,
		...(formData.has("email_notifications_enabled")
			? {
					email_notifications_enabled:
						parsedData.email_notifications_enabled ?? false,
				}
			: {}),
		...(formData.has("sms_notifications_enabled")
			? {
					sms_notifications_enabled:
						parsedData.sms_notifications_enabled ?? false,
				}
			: {}),
		...(formData.has("daily_digest_enabled")
			? {
					daily_digest_enabled: parsedData.daily_digest_enabled ?? false,
				}
			: {}),
	});

	if (normalizedTimes === null) {
		safeNotificationPreferenceUpdates.daily_digest_notification_times = null;
		safeNotificationPreferenceUpdates.daily_digest_enabled = false;
	}

	const timezoneChanged =
		safeNotificationPreferenceUpdates.timezone !== undefined &&
		safeNotificationPreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safeNotificationPreferenceUpdates.daily_digest_notification_times !==
			undefined &&
		serializeTimes(
			safeNotificationPreferenceUpdates.daily_digest_notification_times,
		) !== serializeTimes(dbUser.daily_digest_notification_times ?? null);
	const enabledChanged =
		safeNotificationPreferenceUpdates.daily_digest_enabled !== undefined &&
		safeNotificationPreferenceUpdates.daily_digest_enabled !==
			dbUser.daily_digest_enabled;

	const finalTimezone =
		safeNotificationPreferenceUpdates.timezone !== undefined
			? safeNotificationPreferenceUpdates.timezone
			: dbUser.timezone;
	const finalTimes =
		safeNotificationPreferenceUpdates.daily_digest_notification_times !==
		undefined
			? safeNotificationPreferenceUpdates.daily_digest_notification_times
			: dbUser.daily_digest_notification_times;
	const finalEnabled =
		safeNotificationPreferenceUpdates.daily_digest_enabled !== undefined
			? safeNotificationPreferenceUpdates.daily_digest_enabled
			: dbUser.daily_digest_enabled;

	if ((timezoneChanged || timeChanged || enabledChanged) && finalEnabled) {
		if (!finalTimes || finalTimes.length === 0) {
			safeNotificationPreferenceUpdates.next_send_at = null;
		} else {
			const nextSendAt = calculateNextSendAtFromTimes(
				finalTimes,
				finalTimezone,
				DateTime.utc(),
			);
			if (nextSendAt) {
				const nextSendAtIso = nextSendAt.toISO();
				if (!nextSendAtIso && logger) {
					logger.warn(
						"Failed to format next_send_at ISO for notification-preferences",
						{
							finalTimes,
							finalTimezone,
						},
					);
					safeNotificationPreferenceUpdates.next_send_at = null;
				} else {
					safeNotificationPreferenceUpdates.next_send_at =
						nextSendAtIso ?? null;
				}
			} else {
				if (logger) {
					logger.warn("calculateNextSendAtFromTimes returned null", {
						finalTimes,
						finalTimezone,
					});
				}
				safeNotificationPreferenceUpdates.next_send_at = null;
			}
		}
	} else if (enabledChanged && !finalEnabled) {
		safeNotificationPreferenceUpdates.next_send_at = null;
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
	const timezoneChanged = newTimezone !== dbUser.timezone;
	if (timezoneChanged && dbUser.daily_digest_enabled) {
		if (
			!dbUser.daily_digest_notification_times ||
			dbUser.daily_digest_notification_times.length === 0
		) {
			payload.next_send_at = null;
		} else {
			const nextSendAt = calculateNextSendAtFromTimes(
				dbUser.daily_digest_notification_times,
				newTimezone,
				DateTime.utc(),
			);
			if (nextSendAt) {
				const nextSendAtIso = nextSendAt.toISO();
				if (nextSendAtIso) {
					payload.next_send_at = nextSendAtIso;
				} else if (logger) {
					logger.warn(
						"Failed to convert next_send_at to ISO after timezone change",
						{
							timezone: newTimezone,
							nextSendAt: nextSendAt.toString(),
							nextSendAtIsValid: nextSendAt.isValid,
							nextSendAtInvalidReason: nextSendAt.invalidReason,
						},
					);
					payload.next_send_at = null;
				} else {
					payload.next_send_at = null;
				}
			} else {
				if (logger) {
					logger.warn(
						"calculateNextSendAtFromTimes returned null despite having times",
						{
							timezone: newTimezone,
							timesCount: dbUser.daily_digest_notification_times.length,
						},
					);
				}
				payload.next_send_at = null;
			}
		}
	}
	return payload;
}
