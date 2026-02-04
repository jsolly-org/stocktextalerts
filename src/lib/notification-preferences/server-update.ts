import { DateTime } from "luxon";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
import { calculateNextSendAtFromTimes } from "../time/digest-times";
import { parseTimeToMinutes } from "../time/format";

export type DigestTimesParseResult =
	| { ok: true; times: number[] }
	| { ok: false; reason: string };

export class NotificationPreferencesValidationError extends Error {
	readonly code: "DIGEST_TIMES_REQUIRED";
	readonly userId?: string;

	constructor(message: string, options: { userId?: string }) {
		super(message);
		this.name = "NotificationPreferencesValidationError";
		this.code = "DIGEST_TIMES_REQUIRED";
		this.userId = options.userId;
	}
}

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

// Throws NotificationPreferencesValidationError when daily digest is enabled
// but no digest times are provided, so callers can reject the update instead of
// persisting an unschedulable state.
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
			// This should be validated at the request boundary; fail fast so we
			// don't silently disable digests by overwriting times with [].
			if (logger) {
				logger.info(
					"Invalid digest times in notification preferences payload",
					{
						action: "notification_preferences_update",
						userId: dbUser.id,
						reason: result.reason,
					},
				);
			}
			throw new Error(`Invalid digest times: ${result.reason}`);
		}
		parsedTimes = result.times;
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
			if (logger) {
				logger.info("Daily digest enabled but no digest times provided", {
					action: "notification_preferences_update",
					userId: dbUser.id,
					reason: "digest_times_missing",
					finalTimezone,
					finalTimes,
				});
			}
			throw new NotificationPreferencesValidationError(
				`Invalid digest schedule: daily digest enabled but no notification times provided for timezone ${finalTimezone}`,
				{ userId: dbUser.id },
			);
		} else {
			const nextSendAt = calculateNextSendAtFromTimes(
				finalTimes,
				finalTimezone,
				DateTime.utc(),
			);
			if (!nextSendAt) {
				if (logger) {
					logger.warn("calculateNextSendAtFromTimes returned null", {
						userId: dbUser.id,
						finalTimes,
						finalTimezone,
					});
				}
				throw new Error(
					`Invalid digest schedule: unable to compute next_send_at with ${JSON.stringify(
						{
							finalTimes,
							finalTimezone,
						},
					)}`,
				);
			}

			const nextSendAtIso = nextSendAt.toISO();
			if (!nextSendAtIso) {
				if (logger) {
					logger.warn(
						"Failed to format next_send_at ISO for notification-preferences",
						{
							userId: dbUser.id,
							finalTimes,
							finalTimezone,
							nextSendAt: nextSendAt.toString(),
							nextSendAtIsValid: nextSendAt.isValid,
							nextSendAtInvalidReason: nextSendAt.invalidReason,
						},
					);
				}
				throw new Error(
					`Invalid digest schedule: unable to format next_send_at with ${JSON.stringify(
						{
							finalTimes,
							finalTimezone,
							nextSendAt: nextSendAt.toString(),
							nextSendAtIsValid: nextSendAt.isValid,
							nextSendAtInvalidReason: nextSendAt.invalidReason,
						},
					)}`,
				);
			}

			safeNotificationPreferenceUpdates.next_send_at = nextSendAtIso;
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

// Throws NotificationPreferencesValidationError when the database is in an
// invalid state (daily digest enabled but no digest times), so callers can
// surface the issue instead of silently clearing next_send_at.
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
			if (logger) {
				logger.info(
					"Timezone update rejected: daily digest enabled but no digest times exist",
					{
						action: "notification_preferences_timezone_update",
						userId: dbUser.id,
						reason: "digest_times_missing",
						timezone: newTimezone,
					},
				);
			}
			throw new NotificationPreferencesValidationError(
				"Daily digest is enabled but no notification times exist for this user",
				{ userId: dbUser.id },
			);
		} else {
			const nextSendAt = calculateNextSendAtFromTimes(
				dbUser.daily_digest_notification_times,
				newTimezone,
				DateTime.utc(),
			);
			if (!nextSendAt) {
				if (logger) {
					logger.warn(
						"calculateNextSendAtFromTimes returned null despite having times",
						{
							userId: dbUser.id,
							timezone: newTimezone,
							timesCount: dbUser.daily_digest_notification_times.length,
						},
					);
				}
				throw new Error(
					`Failed to compute next_send_at after timezone change: ${JSON.stringify(
						{
							userId: dbUser.id,
							timezone: newTimezone,
							timesCount: dbUser.daily_digest_notification_times.length,
							nextSendAt: "null",
						},
					)}`,
				);
			}

			const nextSendAtIso = nextSendAt.toISO();
			if (!nextSendAtIso) {
				if (logger) {
					logger.warn(
						"Failed to convert next_send_at to ISO after timezone change",
						{
							userId: dbUser.id,
							timezone: newTimezone,
							nextSendAt: nextSendAt.toString(),
							nextSendAtIsValid: nextSendAt.isValid,
							nextSendAtInvalidReason: nextSendAt.invalidReason,
						},
					);
				}
				throw new Error(
					`Failed to format next_send_at after timezone change: ${JSON.stringify(
						{
							userId: dbUser.id,
							timezone: newTimezone,
							timesCount: dbUser.daily_digest_notification_times.length,
							nextSendAt: nextSendAt.toString(),
							nextSendAtIsValid: nextSendAt.isValid,
							nextSendAtInvalidReason: nextSendAt.invalidReason,
						},
					)}`,
				);
			}

			payload.next_send_at = nextSendAtIso;
		}
	}
	return payload;
}
