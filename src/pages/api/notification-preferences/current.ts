import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";

/**
 * Read the authenticated user's current notification-preferences.
 *
 * Returns a single snapshot of preferences used by the dashboard UI.
 */
export const GET: APIRoute = async ({ url, request, cookies, locals }) => {
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
			"Notification-preferences read attempt without authenticated user",
			{
				reason: "unauthenticated",
			},
		);
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	try {
		const dbUser = await userService.getById(user.id);
		if (!dbUser) {
			logger.error("Notification-preferences read failed: user not found", {
				userId: user.id,
			});
			return jsonResponse(404, { ok: false, message: "user_not_found" });
		}

		return jsonResponse(200, {
			ok: true,
			message: "ok",
			notificationPreferences: {
				market_scheduled_asset_price_enabled:
					dbUser.market_scheduled_asset_price_enabled,
				market_scheduled_asset_price_include_email:
					dbUser.market_scheduled_asset_price_include_email,
				market_scheduled_asset_price_include_sms:
					dbUser.market_scheduled_asset_price_include_sms,
				email_notifications_enabled: dbUser.email_notifications_enabled,
				sms_notifications_enabled: dbUser.sms_notifications_enabled,
				sms_opted_out: dbUser.sms_opted_out,
				phone_verified: dbUser.phone_verified,
				timezone: dbUser.timezone,
				market_scheduled_asset_price_times:
					dbUser.market_scheduled_asset_price_times,
				daily_digest_time: dbUser.daily_digest_time,
				daily_digest_next_send_at: dbUser.daily_digest_next_send_at,
				market_scheduled_asset_price_next_send_at:
					dbUser.market_scheduled_asset_price_next_send_at,
				dismiss_timezone_mismatch_prompts:
					dbUser.dismiss_timezone_mismatch_prompts,
				daily_digest_include_prices_email:
					dbUser.daily_digest_include_prices_email,
				daily_digest_include_prices_sms: dbUser.daily_digest_include_prices_sms,
				daily_digest_include_top_movers_email:
					dbUser.daily_digest_include_top_movers_email,
				daily_digest_include_news_email: dbUser.daily_digest_include_news_email,
				daily_digest_include_rumors_email:
					dbUser.daily_digest_include_rumors_email,
				asset_events_include_calendar_email:
					dbUser.asset_events_include_calendar_email,
				asset_events_include_calendar_sms:
					dbUser.asset_events_include_calendar_sms,
				asset_events_include_ipo_email: dbUser.asset_events_include_ipo_email,
				asset_events_include_ipo_sms: dbUser.asset_events_include_ipo_sms,
				asset_events_include_analyst_email:
					dbUser.asset_events_include_analyst_email,
				asset_events_include_analyst_sms:
					dbUser.asset_events_include_analyst_sms,
				asset_events_include_insider_email:
					dbUser.asset_events_include_insider_email,
				asset_events_include_insider_sms:
					dbUser.asset_events_include_insider_sms,
				asset_events_next_send_at: dbUser.asset_events_next_send_at,
				market_asset_price_alerts_enabled:
					dbUser.market_asset_price_alerts_enabled,
				market_asset_price_alerts_include_email:
					dbUser.market_asset_price_alerts_include_email,
				market_asset_price_alerts_include_sms:
					dbUser.market_asset_price_alerts_include_sms,
				market_asset_price_alert_move_size:
					dbUser.market_asset_price_alert_move_size,
				price_move_alerts_enabled: dbUser.price_move_alerts_enabled,
				price_targets_include_email: dbUser.price_targets_include_email,
				price_targets_include_sms: dbUser.price_targets_include_sms,
			},
		});
	} catch (error) {
		logger.error(
			"Notification-preferences read failed",
			{ userId: user.id, action: "load_notification-preferences" },
			error,
		);
		return jsonResponse(500, { ok: false, message: "read_failed" });
	}
};
