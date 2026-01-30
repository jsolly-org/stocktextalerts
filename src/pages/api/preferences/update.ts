import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { jsonResponse } from "../../../lib/api/json-response";
import {
	createUserService,
	omitUndefined,
	type User,
	type UserUpdateInput,
} from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import { parseTimeToMinutes } from "../../../lib/time/format";
import { calculateNextSendAtFromTimes } from "../../../lib/time/schedule";

const PREFERENCES_SCHEMA = {
	email_notifications_enabled: { type: "boolean" },
	sms_notifications_enabled: { type: "boolean" },
	timezone: { type: "timezone" },
	daily_digest_enabled: { type: "boolean" },
	daily_digest_notification_times: { type: "json_string_array" },
} as const satisfies FormSchema;

type DigestTimesParseResult =
	| { ok: true; times: number[] }
	| { ok: false; reason: string };

function parseDigestTimes(values: string[]): DigestTimesParseResult {
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

export const POST: APIRoute = async ({ request, cookies, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const userService = createUserService(supabase, cookies);

	const user = await userService.getCurrentUser();
	if (!user) {
		logger.info("Preferences update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch (error) {
		logger.info(
			"Preferences update rejected due to malformed request body",
			{
				userId: user.id,
				contentType: request.headers.get("content-type"),
			},
			error,
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}
	const rawTimesValue = formData.get("daily_digest_notification_times");
	const parsed = parseWithSchema(formData, PREFERENCES_SCHEMA);

	if (!parsed.ok) {
		logger.info("Preferences update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	let parsedTimes: number[] | null | undefined;
	if (rawTimesValue === "") {
		parsedTimes = [];
	} else if (parsed.data.daily_digest_notification_times !== undefined) {
		const result = parseDigestTimes(
			parsed.data.daily_digest_notification_times,
		);
		if (!result.ok) {
			logger.info("Preferences update rejected due to invalid digest times", {
				userId: user.id,
				reason: result.reason,
			});
			return jsonResponse(400, { ok: false, message: "invalid_form" });
		}
		parsedTimes = result.times;
	}

	let normalizedTimes: number[] | null | undefined = parsedTimes;
	if (normalizedTimes && normalizedTimes.length === 0) {
		normalizedTimes = null;
	}

	const safePreferenceUpdates: UserUpdateInput = omitUndefined({
		timezone: parsed.data.timezone,
		daily_digest_notification_times: normalizedTimes,
		...(formData.has("email_notifications_enabled")
			? {
					email_notifications_enabled:
						parsed.data.email_notifications_enabled ?? false,
				}
			: {}),
		...(formData.has("sms_notifications_enabled")
			? {
					sms_notifications_enabled:
						parsed.data.sms_notifications_enabled ?? false,
				}
			: {}),
		...(formData.has("daily_digest_enabled")
			? {
					daily_digest_enabled: parsed.data.daily_digest_enabled ?? false,
				}
			: {}),
	});
	if (normalizedTimes === null) {
		safePreferenceUpdates.daily_digest_notification_times = null;
		safePreferenceUpdates.daily_digest_enabled = false;
	}

	let dbUser: User | null;
	try {
		dbUser = await userService.getById(user.id);
	} catch (error) {
		logger.error(
			"Failed to fetch user for preferences update",
			{
				userId: user.id,
			},
			error,
		);
		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_settings",
		});
	}
	if (!dbUser) {
		logger.info("User not found for preferences update", { userId: user.id });
		return jsonResponse(404, { ok: false, message: "user_not_found" });
	}

	const timezoneChanged =
		safePreferenceUpdates.timezone !== undefined &&
		safePreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safePreferenceUpdates.daily_digest_notification_times !== undefined &&
		serializeTimes(safePreferenceUpdates.daily_digest_notification_times) !==
			serializeTimes(dbUser.daily_digest_notification_times ?? null);
	const enabledChanged =
		safePreferenceUpdates.daily_digest_enabled !== undefined &&
		safePreferenceUpdates.daily_digest_enabled !== dbUser.daily_digest_enabled;

	const finalTimezone =
		safePreferenceUpdates.timezone !== undefined
			? safePreferenceUpdates.timezone
			: dbUser.timezone;
	const finalTimes =
		safePreferenceUpdates.daily_digest_notification_times !== undefined
			? safePreferenceUpdates.daily_digest_notification_times
			: dbUser.daily_digest_notification_times;
	const finalEnabled =
		safePreferenceUpdates.daily_digest_enabled !== undefined
			? safePreferenceUpdates.daily_digest_enabled
			: dbUser.daily_digest_enabled;

	if ((timezoneChanged || timeChanged || enabledChanged) && finalEnabled) {
		if (!finalTimes || finalTimes.length === 0) {
			safePreferenceUpdates.next_send_at = null;
		} else {
			const nextSendAt = calculateNextSendAtFromTimes(
				finalTimes,
				finalTimezone,
				DateTime.utc(),
			);
			if (nextSendAt) {
				const nextSendAtIso = nextSendAt.toISO();
				if (!nextSendAtIso) {
					logger.warn("Failed to format next_send_at ISO for preferences", {
						userId: user.id,
						finalTimes,
						finalTimezone,
					});
					safePreferenceUpdates.next_send_at = null;
				} else {
					safePreferenceUpdates.next_send_at = nextSendAtIso;
				}
			} else {
				logger.warn("calculateNextSendAtFromTimes returned null", {
					userId: user.id,
					finalTimes,
					finalTimezone,
				});
				safePreferenceUpdates.next_send_at = null;
			}
		}
	} else if (enabledChanged && !finalEnabled) {
		safePreferenceUpdates.next_send_at = null;
	}

	try {
		const finalSmsNotificationsEnabled =
			safePreferenceUpdates.sms_notifications_enabled !== undefined
				? safePreferenceUpdates.sms_notifications_enabled
				: dbUser.sms_notifications_enabled;
		if (
			finalSmsNotificationsEnabled &&
			(!dbUser.phone_country_code || !dbUser.phone_number)
		) {
			logger.info("SMS preferences enabled without phone", {
				userId: user.id,
			});
			return jsonResponse(400, { ok: false, message: "phone_not_set" });
		}

		const updatedUser = await userService.update(
			user.id,
			safePreferenceUpdates,
		);
		if (!updatedUser) {
			logger.error("User update returned null", { userId: user.id });
			return jsonResponse(404, { ok: false, message: "user_not_found" });
		}

		return jsonResponse(200, {
			ok: true,
			message: "settings_updated",
			preferences: {
				email_notifications_enabled: updatedUser.email_notifications_enabled,
				sms_notifications_enabled: updatedUser.sms_notifications_enabled,
				sms_opted_out: updatedUser.sms_opted_out,
				phone_verified: updatedUser.phone_verified,
				timezone: updatedUser.timezone,
				daily_digest_enabled: updatedUser.daily_digest_enabled,
				daily_digest_notification_times:
					updatedUser.daily_digest_notification_times,
				next_send_at: updatedUser.next_send_at,
				dismiss_timezone_mismatch_prompts:
					updatedUser.dismiss_timezone_mismatch_prompts,
			},
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(
			"Failed to update user preferences",
			{
				userId: user.id,
				preferences: safePreferenceUpdates,
				error: errorMessage,
			},
			error instanceof Error ? error : new Error(String(error)),
		);

		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_settings",
		});
	}
};
