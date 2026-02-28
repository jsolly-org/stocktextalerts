import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { buildNotificationPreferencesUpdatePayload } from "../../../lib/api/notification-preferences-update";
import { createUserService, type User } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import {
	createErrorForLogging,
	extractErrorMessage,
} from "../../../lib/logging/errors";
import { parseScheduledTimes } from "../../../lib/time/scheduled-times";

const NOTIFICATION_PREFERENCES_SCHEMA = {
	market_scheduled_asset_price_enabled: { type: "boolean" },
	email_notifications_enabled: { type: "boolean" },
	sms_notifications_enabled: { type: "boolean" },
	timezone: { type: "timezone" },
	market_scheduled_asset_price_times: { type: "json_string_array" },
	daily_digest_time: { type: "time" },
	daily_digest_include_news_email: { type: "boolean" },
	daily_digest_include_rumors_email: { type: "boolean" },
	market_scheduled_asset_price_include_email: { type: "boolean" },
	market_scheduled_asset_price_include_sms: { type: "boolean" },
	asset_events_include_calendar_email: { type: "boolean" },
	asset_events_include_calendar_sms: { type: "boolean" },
	asset_events_include_ipo_email: { type: "boolean" },
	asset_events_include_ipo_sms: { type: "boolean" },
	asset_events_include_analyst_email: { type: "boolean" },
	asset_events_include_analyst_sms: { type: "boolean" },
	asset_events_include_insider_email: { type: "boolean" },
	asset_events_include_insider_sms: { type: "boolean" },
	market_asset_price_alerts_enabled: { type: "boolean" },
	market_asset_price_alerts_include_email: { type: "boolean" },
	market_asset_price_alerts_include_sms: { type: "boolean" },
	market_asset_price_alert_onboarding_completed: { type: "boolean" },
	market_asset_price_alert_risk_priority: {
		type: "enum",
		values: ["both_equally"],
	},
	market_asset_price_alert_market_context: {
		type: "enum",
		values: ["standout", "any_major"],
	},
	market_asset_price_alert_move_size: {
		type: "enum",
		values: ["moderate", "large"],
	},
	market_asset_price_alert_follow_up_mode: {
		type: "enum",
		values: ["first_only", "allow_follow_up"],
	},
} as const satisfies FormSchema;

const SMS_INCLUDE_FIELDS = [
	"market_scheduled_asset_price_include_sms",
	"asset_events_include_calendar_sms",
	"asset_events_include_ipo_sms",
	"asset_events_include_analyst_sms",
	"asset_events_include_insider_sms",
	"market_asset_price_alerts_include_sms",
] as const;

/**
 * Update the authenticated user's notification-preferences.
 *
 * Accepts a form POST, validates input, enforces SMS opt-out/phone invariants,
 * persists the update, and returns the updated preference snapshot.
 */
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
	const rawTimesValue = formData.get("market_scheduled_asset_price_times");
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

	let parsedMarketScheduledAssetPriceTimes: number[] | undefined;
	if (
		rawTimesValue !== "" &&
		parsed.data.market_scheduled_asset_price_times !== undefined
	) {
		const result = parseScheduledTimes(
			parsed.data.market_scheduled_asset_price_times,
		);
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
		parsedMarketScheduledAssetPriceTimes = result.times;
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
				parsedMarketScheduledAssetPriceTimes,
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
		if (
			dbUser.sms_opted_out &&
			safeNotificationPreferenceUpdates.sms_notifications_enabled === true
		) {
			logger.info("sms_notifications_enabled rejected: user is sms_opted_out", {
				userId: user.id,
			});
			return jsonResponse(400, { ok: false, message: "sms_opted_out" });
		}

		const enablesAnySmsIncludeField = SMS_INCLUDE_FIELDS.some(
			(field) =>
				safeNotificationPreferenceUpdates[field] === true &&
				dbUser[field] !== true,
		);
		if (dbUser.sms_opted_out && enablesAnySmsIncludeField) {
			logger.info("SMS enable rejected: user is sms_opted_out", {
				userId: user.id,
			});
			return jsonResponse(400, { ok: false, message: "sms_opted_out" });
		}
		if (
			enablesAnySmsIncludeField &&
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
				market_scheduled_asset_price_enabled:
					updatedUser.market_scheduled_asset_price_enabled,
				market_scheduled_asset_price_include_email:
					updatedUser.market_scheduled_asset_price_include_email,
				market_scheduled_asset_price_include_sms:
					updatedUser.market_scheduled_asset_price_include_sms,
				email_notifications_enabled: updatedUser.email_notifications_enabled,
				sms_notifications_enabled: updatedUser.sms_notifications_enabled,
				sms_opted_out: updatedUser.sms_opted_out,
				phone_verified: updatedUser.phone_verified,
				timezone: updatedUser.timezone,
				market_scheduled_asset_price_times:
					updatedUser.market_scheduled_asset_price_times,
				daily_digest_time: updatedUser.daily_digest_time,
				daily_digest_next_send_at: updatedUser.daily_digest_next_send_at,
				market_scheduled_asset_price_next_send_at:
					updatedUser.market_scheduled_asset_price_next_send_at,
				dismiss_timezone_mismatch_prompts:
					updatedUser.dismiss_timezone_mismatch_prompts,
				daily_digest_include_news_email:
					updatedUser.daily_digest_include_news_email,
				daily_digest_include_rumors_email:
					updatedUser.daily_digest_include_rumors_email,
				asset_events_include_calendar_email:
					updatedUser.asset_events_include_calendar_email,
				asset_events_include_calendar_sms:
					updatedUser.asset_events_include_calendar_sms,
				asset_events_include_ipo_email:
					updatedUser.asset_events_include_ipo_email,
				asset_events_include_ipo_sms: updatedUser.asset_events_include_ipo_sms,
				asset_events_include_analyst_email:
					updatedUser.asset_events_include_analyst_email,
				asset_events_include_analyst_sms:
					updatedUser.asset_events_include_analyst_sms,
				asset_events_include_insider_email:
					updatedUser.asset_events_include_insider_email,
				asset_events_include_insider_sms:
					updatedUser.asset_events_include_insider_sms,
				asset_events_next_send_at: updatedUser.asset_events_next_send_at,
				market_asset_price_alerts_enabled:
					updatedUser.market_asset_price_alerts_enabled,
				market_asset_price_alerts_include_email:
					updatedUser.market_asset_price_alerts_include_email,
				market_asset_price_alerts_include_sms:
					updatedUser.market_asset_price_alerts_include_sms,
				market_asset_price_alert_onboarding_completed:
					updatedUser.market_asset_price_alert_onboarding_completed,
				market_asset_price_alert_risk_priority:
					updatedUser.market_asset_price_alert_risk_priority,
				market_asset_price_alert_market_context:
					updatedUser.market_asset_price_alert_market_context,
				market_asset_price_alert_move_size:
					updatedUser.market_asset_price_alert_move_size,
				market_asset_price_alert_follow_up_mode:
					updatedUser.market_asset_price_alert_follow_up_mode,
			},
		});
	} catch (error) {
		logger.error(
			"Failed to update notification-preferences",
			{
				userId: user.id,
				notificationPreferences: safeNotificationPreferenceUpdates,
				error: extractErrorMessage(error),
			},
			createErrorForLogging(error),
		);

		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_settings",
		});
	}
};
