import type { APIRoute } from "astro";
import { createUserService, type User } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { jsonResponse } from "../../../lib/json-response";
import { createLogger } from "../../../lib/logging";
import {
	buildNotificationPreferencesUpdatePayload,
	parseDigestTimes,
} from "../../../lib/notification-preferences/server-update";

const NOTIFICATION_PREFERENCES_SCHEMA = {
	email_notifications_enabled: { type: "boolean" },
	sms_notifications_enabled: { type: "boolean" },
	timezone: { type: "timezone" },
	daily_digest_enabled: { type: "boolean" },
	daily_digest_notification_times: { type: "json_string_array" },
} as const satisfies FormSchema;

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
		logger.info(
			"Notification-preferences update attempt without authenticated user",
			{
				reason: "unauthenticated",
			},
		);
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch (error) {
		logger.info(
			"Notification-preferences update rejected due to malformed request body",
			{
				userId: user.id,
				contentType: request.headers.get("content-type"),
			},
			error,
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}
	const rawTimesValue = formData.get("daily_digest_notification_times");
	const parsed = parseWithSchema(formData, NOTIFICATION_PREFERENCES_SCHEMA);

	if (!parsed.ok) {
		logger.info(
			"Notification-preferences update rejected due to invalid form",
			{
				userId: user.id,
				errors: parsed.allErrors,
			},
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	if (
		rawTimesValue !== "" &&
		parsed.data.daily_digest_notification_times !== undefined
	) {
		const result = parseDigestTimes(
			parsed.data.daily_digest_notification_times,
		);
		if (!result.ok) {
			logger.info(
				"Notification-preferences update rejected due to invalid digest times",
				{
					userId: user.id,
					reason: result.reason,
				},
			);
			return jsonResponse(400, { ok: false, message: "invalid_form" });
		}
	}

	let dbUser: User | null;
	try {
		dbUser = await userService.getById(user.id);
	} catch (error) {
		logger.error(
			"Failed to fetch user for notification-preferences update",
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
		logger.info("User not found for notification-preferences update", {
			userId: user.id,
		});
		return jsonResponse(404, { ok: false, message: "user_not_found" });
	}

	const safeNotificationPreferenceUpdates =
		buildNotificationPreferencesUpdatePayload({
			parsedData: parsed.data,
			formData,
			rawTimesValue: rawTimesValue as string | null,
			dbUser,
			logger,
		});

	try {
		const finalSmsNotificationsEnabled =
			safeNotificationPreferenceUpdates.sms_notifications_enabled !== undefined
				? safeNotificationPreferenceUpdates.sms_notifications_enabled
				: dbUser.sms_notifications_enabled;
		if (
			finalSmsNotificationsEnabled &&
			(!dbUser.phone_country_code || !dbUser.phone_number)
		) {
			logger.info("SMS notification-preferences enabled without phone number", {
				userId: user.id,
			});
			return jsonResponse(400, { ok: false, message: "phone_not_set" });
		}

		const updatedUser = await userService.update(
			user.id,
			safeNotificationPreferenceUpdates,
		);
		if (!updatedUser) {
			logger.error("User update returned null", { userId: user.id });
			return jsonResponse(404, { ok: false, message: "user_not_found" });
		}

		return jsonResponse(200, {
			ok: true,
			message: "settings_updated",
			notificationPreferences: {
				email_notifications_enabled: updatedUser.email_notifications_enabled,
				sms_notifications_enabled: updatedUser.sms_notifications_enabled,
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
			"Failed to update notification-preferences",
			{
				userId: user.id,
				notificationPreferences: safeNotificationPreferenceUpdates,
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
