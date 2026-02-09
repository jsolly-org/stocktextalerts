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
				price_notifications_enabled: dbUser.price_notifications_enabled,
				price_include_email: dbUser.price_include_email,
				price_include_sms: dbUser.price_include_sms,
				email_notifications_enabled: dbUser.email_notifications_enabled,
				sms_notifications_enabled: dbUser.sms_notifications_enabled,
				sms_opted_out: dbUser.sms_opted_out,
				phone_verified: dbUser.phone_verified,
				timezone: dbUser.timezone,
				scheduled_update_times: dbUser.scheduled_update_times,
				only_notify_when_market_open: dbUser.only_notify_when_market_open,
				daily_only_notify_when_market_open:
					dbUser.daily_only_notify_when_market_open,
				daily_delivery_time: dbUser.daily_delivery_time,
				daily_next_send_at: dbUser.daily_next_send_at,
				next_send_at: dbUser.next_send_at,
				dismiss_timezone_mismatch_prompts:
					dbUser.dismiss_timezone_mismatch_prompts,
				daily_include_news_email: dbUser.daily_include_news_email,
				daily_include_rumors_email: dbUser.daily_include_rumors_email,
				daily_include_analyst_email: dbUser.daily_include_analyst_email,
				daily_include_insider_email: dbUser.daily_include_insider_email,
				daily_include_analyst_sms: dbUser.daily_include_analyst_sms,
				daily_include_insider_sms: dbUser.daily_include_insider_sms,
				weekly_include_earnings_email: dbUser.weekly_include_earnings_email,
				weekly_include_earnings_sms: dbUser.weekly_include_earnings_sms,
				weekly_next_send_at: dbUser.weekly_next_send_at,
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
