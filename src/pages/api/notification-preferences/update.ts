import type { APIRoute } from "astro";
import { createUserService, type User } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { jsonResponse } from "../../../lib/json-response";
import { createLogger } from "../../../lib/logging";
import { parseScheduledTimes } from "../../../lib/notification-preferences/scheduled-times";
import { buildNotificationPreferencesUpdatePayload } from "../../../lib/notification-preferences/server-update";

const NOTIFICATION_PREFERENCES_SCHEMA = {
	price_notifications_enabled: { type: "boolean" },
	email_notifications_enabled: { type: "boolean" },
	sms_notifications_enabled: { type: "boolean" },
	timezone: { type: "timezone" },
	scheduled_update_times: { type: "json_string_array" },
	only_notify_when_market_open: { type: "boolean" },
	daily_only_notify_when_market_open: { type: "boolean" },
	daily_delivery_time: { type: "time" },
	daily_include_news_email: { type: "boolean" },
	daily_include_rumors_email: { type: "boolean" },
	daily_include_analyst_email: { type: "boolean" },
	daily_include_insider_email: { type: "boolean" },
	daily_include_analyst_sms: { type: "boolean" },
	daily_include_insider_sms: { type: "boolean" },
	price_include_email: { type: "boolean" },
	price_include_sms: { type: "boolean" },
	weekly_include_earnings_email: { type: "boolean" },
	weekly_include_earnings_sms: { type: "boolean" },
	weekly_include_dividends_email: { type: "boolean" },
	weekly_include_dividends_sms: { type: "boolean" },
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
	const rawTimesValue = formData.get("scheduled_update_times");
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
		parsed.data.scheduled_update_times !== undefined
	) {
		const result = parseScheduledTimes(parsed.data.scheduled_update_times);
		if (!result.ok) {
			logger.info(
				"Notification-preferences update rejected due to invalid scheduled times",
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

	let safeNotificationPreferenceUpdates: ReturnType<
		typeof buildNotificationPreferencesUpdatePayload
	>;
	try {
		safeNotificationPreferenceUpdates =
			buildNotificationPreferencesUpdatePayload({
				parsedData: parsed.data,
				formData,
				rawTimesValue: rawTimesValue as string | null,
				dbUser,
				logger,
			});
	} catch (error) {
		logger.error(
			"Notification-preferences update rejected due to invalid update schedule",
			{
				userId: user.id,
				action: "notification_preferences_update",
			},
			error,
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	try {
		const requestedSmsNotificationsEnabled =
			safeNotificationPreferenceUpdates.sms_notifications_enabled;
		if (requestedSmsNotificationsEnabled === true && dbUser.sms_opted_out) {
			logger.info("SMS enable rejected: user is sms_opted_out", {
				userId: user.id,
			});
			return jsonResponse(400, { ok: false, message: "sms_opted_out" });
		}
		const finalSmsNotificationsEnabled =
			requestedSmsNotificationsEnabled ?? dbUser.sms_notifications_enabled;
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
				price_notifications_enabled: updatedUser.price_notifications_enabled,
				price_include_email: updatedUser.price_include_email,
				price_include_sms: updatedUser.price_include_sms,
				email_notifications_enabled: updatedUser.email_notifications_enabled,
				sms_notifications_enabled: updatedUser.sms_notifications_enabled,
				sms_opted_out: updatedUser.sms_opted_out,
				phone_verified: updatedUser.phone_verified,
				timezone: updatedUser.timezone,
				scheduled_update_times: updatedUser.scheduled_update_times,
				only_notify_when_market_open: updatedUser.only_notify_when_market_open,
				daily_only_notify_when_market_open:
					updatedUser.daily_only_notify_when_market_open,
				daily_delivery_time: updatedUser.daily_delivery_time,
				daily_next_send_at: updatedUser.daily_next_send_at,
				next_send_at: updatedUser.next_send_at,
				dismiss_timezone_mismatch_prompts:
					updatedUser.dismiss_timezone_mismatch_prompts,
				daily_include_news_email: updatedUser.daily_include_news_email,
				daily_include_rumors_email: updatedUser.daily_include_rumors_email,
				daily_include_analyst_email: updatedUser.daily_include_analyst_email,
				daily_include_insider_email: updatedUser.daily_include_insider_email,
				daily_include_analyst_sms: updatedUser.daily_include_analyst_sms,
				daily_include_insider_sms: updatedUser.daily_include_insider_sms,
				weekly_include_earnings_email:
					updatedUser.weekly_include_earnings_email,
				weekly_include_earnings_sms: updatedUser.weekly_include_earnings_sms,
				weekly_include_dividends_email:
					updatedUser.weekly_include_dividends_email,
				weekly_include_dividends_sms: updatedUser.weekly_include_dividends_sms,
				weekly_next_send_at: updatedUser.weekly_next_send_at,
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
