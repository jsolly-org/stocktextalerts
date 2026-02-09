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
				daily_include_news: dbUser.daily_include_news,
				daily_include_rumors: dbUser.daily_include_rumors,
				daily_include_analyst: dbUser.daily_include_analyst,
				daily_include_insider: dbUser.daily_include_insider,
				weekly_include_earnings: dbUser.weekly_include_earnings,
				weekly_include_dividends: dbUser.weekly_include_dividends,
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
