import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";

/** Read the authenticated user's current notification preferences snapshot. */
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
				email_notifications_enabled: dbUser.email_notifications_enabled,
				sms_notifications_enabled: dbUser.sms_notifications_enabled,
				sms_opted_out: dbUser.sms_opted_out,
				phone_verified: dbUser.phone_verified,
				timezone: dbUser.timezone,
				scheduled_updates_enabled: dbUser.scheduled_updates_enabled,
				scheduled_update_times: dbUser.scheduled_update_times,
				only_notify_when_market_open: dbUser.only_notify_when_market_open,
				add_ons_notifications_enabled: dbUser.add_ons_notifications_enabled,
				add_ons_delivery_time: dbUser.add_ons_delivery_time,
				add_ons_next_send_at: dbUser.add_ons_next_send_at,
				next_send_at: dbUser.next_send_at,
				dismiss_timezone_mismatch_prompts:
					dbUser.dismiss_timezone_mismatch_prompts,
				first_notification_include_news: dbUser.first_notification_include_news,
				first_notification_include_rumors:
					dbUser.first_notification_include_rumors,
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
