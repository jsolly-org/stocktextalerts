import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { createUserService, omitUndefined } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import { calculateNextSendAt } from "../../../lib/time/schedule";

const PREFERENCES_SCHEMA = {
	email_notifications_enabled: { type: "boolean" },
	sms_notifications_enabled: { type: "boolean" },
	timezone: { type: "timezone" },
	daily_digest_enabled: { type: "boolean" },
	daily_digest_notification_time: { type: "time" },
} as const satisfies FormSchema;

export const POST: APIRoute = async ({
	request,
	cookies,
	redirect,
	locals,
}) => {
	const wantsJson = request.headers
		.get("accept")
		?.toLowerCase()
		.includes("application/json");
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
		logger.info("Preferences update attempt without authenticated user");
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "unauthorized" },
				{ status: 401 },
			);
		}
		return redirect("/signin?error=unauthorized");
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, PREFERENCES_SCHEMA);

	if (!parsed.ok) {
		logger.info("Preferences update rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "invalid_form" },
				{ status: 400 },
			);
		}
		return redirect("/dashboard?error=invalid_form");
	}

	const safePreferenceUpdates: Parameters<typeof userService.update>[1] =
		omitUndefined({
			timezone: parsed.data.timezone,
			daily_digest_notification_time:
				parsed.data.daily_digest_notification_time,
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

	const dbUser = await userService.getById(user.id);
	if (!dbUser) {
		logger.error("User not found", { userId: user.id });
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "user_not_found" },
				{ status: 404 },
			);
		}
		return redirect("/signin?error=user_not_found");
	}

	const timezoneChanged =
		safePreferenceUpdates.timezone !== undefined &&
		safePreferenceUpdates.timezone !== dbUser.timezone;
	const timeChanged =
		safePreferenceUpdates.daily_digest_notification_time !== undefined &&
		safePreferenceUpdates.daily_digest_notification_time !==
			dbUser.daily_digest_notification_time;
	const enabledChanged =
		safePreferenceUpdates.daily_digest_enabled !== undefined &&
		safePreferenceUpdates.daily_digest_enabled !== dbUser.daily_digest_enabled;

	const finalTimezone = safePreferenceUpdates.timezone ?? dbUser.timezone;
	const finalTime =
		safePreferenceUpdates.daily_digest_notification_time ??
		dbUser.daily_digest_notification_time;
	const finalEnabled =
		safePreferenceUpdates.daily_digest_enabled ?? dbUser.daily_digest_enabled;

	if ((timezoneChanged || timeChanged || enabledChanged) && finalEnabled) {
		const nextSendAt = calculateNextSendAt(
			finalTime,
			finalTimezone,
			DateTime.utc(),
		);
		if (nextSendAt) {
			const nextSendAtIso = nextSendAt.toISO();
			if (!nextSendAtIso) {
				logger.warn("Failed to format next_send_at ISO for preferences", {
					userId: user.id,
					finalTime,
					finalTimezone,
				});
			} else {
				safePreferenceUpdates.next_send_at = nextSendAtIso;
			}
		} else {
			logger.warn("calculateNextSendAt returned null for valid inputs", {
				userId: user.id,
				finalTime,
				finalTimezone,
			});
			safePreferenceUpdates.next_send_at = null;
		}
	} else if (enabledChanged && !finalEnabled) {
		safePreferenceUpdates.next_send_at = null;
	}

	try {
		const finalSmsNotificationsEnabled =
			safePreferenceUpdates.sms_notifications_enabled ??
			dbUser.sms_notifications_enabled;
		if (finalSmsNotificationsEnabled && !dbUser.phone_number) {
			logger.error("SMS preferences enabled without phone", {
				userId: user.id,
			});
			if (wantsJson) {
				return Response.json(
					{ ok: false, message: "phone_not_set" },
					{ status: 400 },
				);
			}
			return redirect("/dashboard?error=phone_not_set");
		}

		await userService.update(user.id, safePreferenceUpdates);
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

		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "update_failed" },
				{ status: 500 },
			);
		}
		return redirect("/dashboard?error=update_failed");
	}

	if (wantsJson) {
		const updatedUser = await userService.getById(user.id);
		if (!updatedUser) {
			logger.error("User not found after update", { userId: user.id });
			return Response.json(
				{ ok: false, message: "user_not_found" },
				{ status: 404 },
			);
		}

		return Response.json({
			ok: true,
			message: "settings_updated",
			preferences: {
				email_notifications_enabled: updatedUser.email_notifications_enabled,
				sms_notifications_enabled: updatedUser.sms_notifications_enabled,
				sms_opted_out: updatedUser.sms_opted_out,
				phone_verified: updatedUser.phone_verified,
				timezone: updatedUser.timezone,
				daily_digest_enabled: updatedUser.daily_digest_enabled,
				daily_digest_notification_time:
					updatedUser.daily_digest_notification_time,
				next_send_at: updatedUser.next_send_at,
				dismiss_timezone_mismatch_prompts:
					updatedUser.dismiss_timezone_mismatch_prompts,
			},
		});
	}

	return redirect("/dashboard?success=settings_updated");
};
