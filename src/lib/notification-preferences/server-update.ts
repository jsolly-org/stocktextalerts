import { DEFAULT_DAILY_DIGEST_TIME_MINUTES } from "../constants";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
import { shouldSendSms } from "../messaging/sms";
import {
	computeNextSendAtIso,
	parseDigestTimes,
	serializeTimes,
} from "./digest-times";

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
			logger?.info("Invalid digest times in notification preferences payload", {
				action: "notification_preferences_update",
				userId: dbUser.id,
				reason: result.reason,
			});
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

	const finalEmailNotificationsEnabled =
		safeNotificationPreferenceUpdates.email_notifications_enabled ??
		dbUser.email_notifications_enabled;
	const finalSmsNotificationsEnabled =
		safeNotificationPreferenceUpdates.sms_notifications_enabled ??
		dbUser.sms_notifications_enabled;
	const hadAnyChannelBefore =
		dbUser.email_notifications_enabled || shouldSendSms(dbUser);
	const hasAnyChannelAfter =
		finalEmailNotificationsEnabled ||
		shouldSendSms({
			...dbUser,
			sms_notifications_enabled: finalSmsNotificationsEnabled,
		});
	const gainedFirstChannel = !hadAnyChannelBefore && hasAnyChannelAfter;

	const finalTimezone =
		safeNotificationPreferenceUpdates.timezone ?? dbUser.timezone;
	let finalTimes =
		safeNotificationPreferenceUpdates.daily_digest_notification_times !==
		undefined
			? safeNotificationPreferenceUpdates.daily_digest_notification_times
			: dbUser.daily_digest_notification_times;
	let finalEnabled =
		safeNotificationPreferenceUpdates.daily_digest_enabled ??
		dbUser.daily_digest_enabled;

	// When a user enables their first usable notification channel, automatically
	// enable daily digests and set a default digest time so scheduling works without
	// requiring extra UI steps.
	if (gainedFirstChannel) {
		if (!finalTimes || finalTimes.length === 0) {
			safeNotificationPreferenceUpdates.daily_digest_notification_times = [
				DEFAULT_DAILY_DIGEST_TIME_MINUTES,
			];
			finalTimes =
				safeNotificationPreferenceUpdates.daily_digest_notification_times;
		}
		if (!finalEnabled) {
			safeNotificationPreferenceUpdates.daily_digest_enabled = true;
			finalEnabled = true;
		}
	}

	// Self-heal: if daily digests are enabled but next_send_at is missing (e.g. legacy/buggy state),
	// recompute it on the next preferences update so cron delivery can resume.
	const needsNextSendAtRepair =
		finalEnabled &&
		dbUser.next_send_at === null &&
		safeNotificationPreferenceUpdates.next_send_at === undefined;

	if (
		(timezoneChanged ||
			timeChanged ||
			enabledChanged ||
			gainedFirstChannel ||
			needsNextSendAtRepair) &&
		finalEnabled
	) {
		if (!finalTimes || finalTimes.length === 0) {
			logger?.info("Daily digest enabled but no digest times provided", {
				action: "notification_preferences_update",
				userId: dbUser.id,
				reason: "digest_times_missing",
				finalTimezone,
				finalTimes,
			});
			throw new NotificationPreferencesValidationError(
				`Invalid digest schedule: daily digest enabled but no notification times provided for timezone ${finalTimezone}`,
				{ userId: dbUser.id },
			);
		}
		safeNotificationPreferenceUpdates.next_send_at = computeNextSendAtIso(
			finalTimes,
			finalTimezone,
			{ userId: dbUser.id, finalTimes, finalTimezone },
			logger,
		);
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

	if (newTimezone === dbUser.timezone || !dbUser.daily_digest_enabled) {
		return payload;
	}

	if (
		!dbUser.daily_digest_notification_times ||
		dbUser.daily_digest_notification_times.length === 0
	) {
		logger?.warn(
			"Digest enabled without notification times on timezone change",
			{
				action: "notification_preferences_timezone_update",
				userId: dbUser.id,
				reason: "digest_times_missing",
				timezone: newTimezone,
			},
		);
		throw new NotificationPreferencesValidationError(
			`Invalid digest schedule: daily digest enabled but no notification times exist for timezone ${newTimezone}`,
			{ userId: dbUser.id },
		);
	}

	payload.next_send_at = computeNextSendAtIso(
		dbUser.daily_digest_notification_times,
		newTimezone,
		{
			userId: dbUser.id,
			timezone: newTimezone,
			timesCount: dbUser.daily_digest_notification_times.length,
		},
		logger,
	);

	return payload;
}
