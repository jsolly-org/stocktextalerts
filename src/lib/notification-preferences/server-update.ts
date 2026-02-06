import { DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES } from "../constants";
import { omitUndefined, type User, type UserUpdateInput } from "../db";
import type { Logger } from "../logging";
import { shouldSendSms } from "../messaging/sms";
import {
	computeNextSendAtIso,
	parseScheduledTimes,
	serializeTimes,
} from "./scheduled-times";

export class NotificationPreferencesValidationError extends Error {
	readonly code: "UPDATE_TIMES_REQUIRED";
	readonly userId?: string;

	constructor(message: string, options: { userId?: string }) {
		super(message);
		this.name = "NotificationPreferencesValidationError";
		this.code = "UPDATE_TIMES_REQUIRED";
		this.userId = options.userId;
	}
}

export interface ParsedNotificationPreferencesForm {
	timezone?: string;
	email_notifications_enabled?: boolean;
	sms_notifications_enabled?: boolean;
	scheduled_updates_enabled?: boolean;
	scheduled_update_times?: string[];
}

// Throws NotificationPreferencesValidationError when scheduled updates are enabled
// but no notification times are provided, so callers can reject the update instead of
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
			throw new NotificationPreferencesValidationError(
				`Invalid scheduled times: ${result.reason}`,
				{ userId: dbUser.id },
			);
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
		scheduled_update_times: normalizedTimes,
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
		...(formData.has("scheduled_updates_enabled")
			? {
					scheduled_updates_enabled:
						parsedData.scheduled_updates_enabled ?? false,
				}
			: {}),
	});

	if (normalizedTimes === null) {
		safeNotificationPreferenceUpdates.scheduled_update_times = null;
		safeNotificationPreferenceUpdates.scheduled_updates_enabled = false;
	}

	const timezoneChanged =
		safeNotificationPreferenceUpdates.timezone !== undefined &&
		safeNotificationPreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safeNotificationPreferenceUpdates.scheduled_update_times !== undefined &&
		serializeTimes(safeNotificationPreferenceUpdates.scheduled_update_times) !==
			serializeTimes(dbUser.scheduled_update_times ?? null);
	const enabledChanged =
		safeNotificationPreferenceUpdates.scheduled_updates_enabled !== undefined &&
		safeNotificationPreferenceUpdates.scheduled_updates_enabled !==
			dbUser.scheduled_updates_enabled;

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
		safeNotificationPreferenceUpdates.scheduled_update_times !== undefined
			? safeNotificationPreferenceUpdates.scheduled_update_times
			: dbUser.scheduled_update_times;
	let finalEnabled =
		safeNotificationPreferenceUpdates.scheduled_updates_enabled ??
		dbUser.scheduled_updates_enabled;

	// When a user enables their first usable notification channel, automatically
	// enable scheduled updates and set a default notification time so scheduling works without
	// requiring extra UI steps.
	if (gainedFirstChannel) {
		if (!finalTimes || finalTimes.length === 0) {
			safeNotificationPreferenceUpdates.scheduled_update_times = [
				DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES,
			];
			finalTimes = safeNotificationPreferenceUpdates.scheduled_update_times;
		}
		if (!finalEnabled) {
			safeNotificationPreferenceUpdates.scheduled_updates_enabled = true;
			finalEnabled = true;
		}
	}

	// Self-heal: if scheduled updates are enabled but next_send_at is missing (e.g. legacy/buggy state),
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
			logger?.info(
				"Scheduled updates enabled but no notification times provided",
				{
					action: "notification_preferences_update",
					userId: dbUser.id,
					reason: "update_times_missing",
					finalTimezone,
					finalTimes,
				},
			);
			throw new NotificationPreferencesValidationError(
				`Invalid schedule: updates enabled but no notification times provided for timezone ${finalTimezone}`,
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
// invalid state (updates enabled but no notification times), so callers can
// surface the issue instead of silently clearing next_send_at.
export function computeTimezoneUpdatePayload(
	newTimezone: string,
	dbUser: User,
	logger?: Logger,
): TimezoneUpdatePayload {
	const payload: TimezoneUpdatePayload = {
		timezone: newTimezone,
	};

	if (newTimezone === dbUser.timezone || !dbUser.scheduled_updates_enabled) {
		return payload;
	}

	if (
		!dbUser.scheduled_update_times ||
		dbUser.scheduled_update_times.length === 0
	) {
		logger?.warn(
			"Scheduled updates enabled without notification times on timezone change",
			{
				action: "notification_preferences_timezone_update",
				userId: dbUser.id,
				reason: "update_times_missing",
				timezone: newTimezone,
			},
		);
		throw new NotificationPreferencesValidationError(
			`Invalid schedule: updates enabled but no notification times exist for timezone ${newTimezone}`,
			{ userId: dbUser.id },
		);
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
