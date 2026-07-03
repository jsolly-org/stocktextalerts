import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../lib/client/types";
import { hasAnyDailyNotificationFacet } from "../../../lib/daily-notification/eligibility";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import type { User } from "../../../lib/db/types";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";
import { loadUserPreferenceRows } from "../../../lib/notification-preferences/channels";
import { computeTimezoneUpdatePayload } from "../../../lib/notification-preferences/update-payload";

export const POST: APIRoute = async ({ url, request, cookies, locals }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);

	const authUser = await users.getCurrentUser();
	if (!authUser) {
		logger.info("Notification-preferences timezone update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		timezone: { type: "timezone", required: true },
	} as const);

	if (!parsed.ok) {
		logger.info("Notification-preferences timezone update rejected", {
			userId: authUser.id,
			errors: parsed.allErrors,
		});
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	let dbUser: User | null;
	try {
		dbUser = await users.getById(authUser.id);
	} catch (error) {
		logger.error(
			"Failed to fetch user for notification-preferences timezone update",
			{ userId: authUser.id },
			createErrorForLogging(error),
		);
		return Response.json(
			{
				ok: false,
				message: "failed_to_update_timezone",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}
	if (!dbUser) {
		logger.info("User not found for timezone update", { userId: authUser.id });
		return Response.json({ ok: false, message: "user_not_found" } satisfies ApiJsonBody, {
			status: 404,
		});
	}

	// Daily notification facets (digest + asset events) live in notification_preferences;
	// resolve whether any channel facet is on to decide if daily_notification_next_send_at
	// needs recomputing — not asset-event facets only.
	let prefs: Awaited<ReturnType<typeof loadUserPreferenceRows>>;
	try {
		prefs = await loadUserPreferenceRows(supabase, authUser.id);
	} catch (error) {
		logger.error(
			"Failed to load notification preferences for timezone update",
			{ userId: authUser.id },
			createErrorForLogging(error),
		);
		return Response.json(
			{
				ok: false,
				message: "failed_to_update_timezone",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}
	const hasDailyNotification = hasAnyDailyNotificationFacet(prefs);

	let updatePayload: ReturnType<typeof computeTimezoneUpdatePayload>;
	try {
		updatePayload = computeTimezoneUpdatePayload(
			parsed.data.timezone,
			dbUser,
			hasDailyNotification,
		);
	} catch (error) {
		logger.error(
			"Failed to compute timezone update payload",
			{
				userId: authUser.id,
				timezone: parsed.data.timezone,
			},
			createErrorForLogging(error),
		);
		return Response.json(
			{
				ok: false,
				message: "failed_to_update_timezone",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}

	let updatedUser: User;
	try {
		updatedUser = await users.update(authUser.id, updatePayload);
	} catch (error) {
		logger.error(
			"Failed to update timezone",
			{
				userId: authUser.id,
				timezone: parsed.data.timezone,
			},
			createErrorForLogging(error),
		);
		return Response.json(
			{
				ok: false,
				message: "failed_to_update_timezone",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}
	if (!updatedUser) {
		logger.error("User update returned null", { userId: authUser.id });
		return Response.json({ ok: false, message: "user_not_found" } satisfies ApiJsonBody, {
			status: 404,
		});
	}

	return Response.json(
		{
			ok: true,
			message: "timezone_updated",
			notificationPreferences: {
				timezone: updatedUser.timezone,
				market_scheduled_asset_price_next_send_at:
					updatedUser.market_scheduled_asset_price_next_send_at,
				daily_notification_next_send_at: updatedUser.daily_notification_next_send_at,
			},
		} satisfies ApiJsonBody,
		{ status: 200 },
	);
};
