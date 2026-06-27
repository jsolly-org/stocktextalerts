import type { APIRoute } from "astro";
import {
	buildChannelPreferenceSnapshot,
	loadUserPreferenceRows,
} from "../../../lib/api/notification-preferences-channels";
import type { ApiJsonBody } from "../../../lib/api/types";
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
		logger.info("Notification-preferences read attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	try {
		const dbUser = await userService.getById(user.id);
		if (!dbUser) {
			logger.error("Notification-preferences read failed: user not found", {
				userId: user.id,
			});
			return Response.json({ ok: false, message: "user_not_found" } satisfies ApiJsonBody, {
				status: 404,
			});
		}

		// Per-option channel facets live in notification_preferences (the source of
		// truth); reconstruct the flat per-option snapshot the UI consumes.
		const prefs = await loadUserPreferenceRows(supabase, user.id);

		return Response.json(
			{
				ok: true,
				message: "ok",
				notificationPreferences: {
					market_scheduled_asset_price_enabled: dbUser.market_scheduled_asset_price_enabled,
					email_notifications_enabled: dbUser.email_notifications_enabled,
					sms_notifications_enabled: dbUser.sms_notifications_enabled,
					sms_opted_out: dbUser.sms_opted_out,
					phone_verified: dbUser.phone_verified,
					timezone: dbUser.timezone,
					market_scheduled_asset_price_times: dbUser.market_scheduled_asset_price_times,
					daily_digest_time: dbUser.daily_digest_time,
					daily_digest_next_send_at: dbUser.daily_digest_next_send_at,
					market_scheduled_asset_price_next_send_at:
						dbUser.market_scheduled_asset_price_next_send_at,
					dismiss_timezone_mismatch_prompts: dbUser.dismiss_timezone_mismatch_prompts,
					asset_events_next_send_at: dbUser.asset_events_next_send_at,
					market_asset_price_alerts_enabled: dbUser.market_asset_price_alerts_enabled,
					market_asset_price_alert_move_size: dbUser.market_asset_price_alert_move_size,
					...buildChannelPreferenceSnapshot(prefs),
				},
			} satisfies ApiJsonBody,
			{ status: 200 },
		);
	} catch (error) {
		logger.error(
			"Notification-preferences read failed",
			{ userId: user.id, action: "load_notification-preferences" },
			error,
		);
		return Response.json({ ok: false, message: "read_failed" } satisfies ApiJsonBody, {
			status: 500,
		});
	}
};
