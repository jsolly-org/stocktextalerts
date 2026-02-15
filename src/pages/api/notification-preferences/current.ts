import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";

export const GET: APIRoute = async ({ request, cookies, locals }) => {
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
			"Notification-preferences read attempt without authenticated user",
			{
				reason: "unauthenticated",
			},
		);
		return Response.json(
			{ ok: false, message: "unauthorized" },
			{ status: 401 },
		);
	}

	try {
		const dbUser = await userService.getById(user.id);
		if (!dbUser) {
			logger.error("Notification-preferences read failed: user not found", {
				userId: user.id,
			});
			return Response.json(
				{ ok: false, message: "user_not_found" },
				{ status: 404 },
			);
		}

		return Response.json({
			ok: true,
			notificationPreferences: {
				market_scheduled_asset_price_enabled:
					dbUser.market_scheduled_asset_price_enabled,
				market_scheduled_asset_price_include_email:
					dbUser.market_scheduled_asset_price_include_email,
				market_scheduled_asset_price_include_sms:
					dbUser.market_scheduled_asset_price_include_sms,
				email_notifications_enabled: dbUser.email_notifications_enabled,
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
			},
		});
	} catch (error) {
		logger.error(
			"Notification-preferences read failed",
			{ userId: user.id, action: "load_notification-preferences" },
			error,
		);
		return Response.json(
			{ ok: false, message: "read_failed" },
			{ status: 500 },
		);
	}
};
