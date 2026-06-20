import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { loadUserPreferenceRows } from "../../../lib/api/notification-preferences-channels";
import { computeTimezoneUpdatePayload } from "../../../lib/api/notification-preferences-update";
import { createUserService, type User } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";
import { anyFacetEnabled } from "../../../lib/messaging/notification-prefs";

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
		return jsonResponse(401, { ok: false, message: "unauthorized" });
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
		return jsonResponse(400, { ok: false, message: "invalid_form" });
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
		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_timezone",
		});
	}
	if (!dbUser) {
		logger.info("User not found for timezone update", { userId: authUser.id });
		return jsonResponse(404, { ok: false, message: "user_not_found" });
	}

	// Asset-events facets live in notification_preferences; resolve whether any
	// email/sms facet is on to decide if asset_events_next_send_at needs recomputing.
	const prefs = await loadUserPreferenceRows(supabase, authUser.id);
	const hasAnyAssetEvents =
		anyFacetEnabled(prefs, "asset_events", "email") ||
		anyFacetEnabled(prefs, "asset_events", "sms");

	let updatePayload: ReturnType<typeof computeTimezoneUpdatePayload>;
	try {
		updatePayload = computeTimezoneUpdatePayload(parsed.data.timezone, dbUser, hasAnyAssetEvents);
	} catch (error) {
		logger.error(
			"Failed to compute timezone update payload",
			{
				userId: authUser.id,
				timezone: parsed.data.timezone,
			},
			createErrorForLogging(error),
		);
		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_timezone",
		});
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
		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_timezone",
		});
	}
	if (!updatedUser) {
		logger.error("User update returned null", { userId: authUser.id });
		return jsonResponse(404, { ok: false, message: "user_not_found" });
	}

	return jsonResponse(200, {
		ok: true,
		message: "timezone_updated",
		notificationPreferences: {
			timezone: updatedUser.timezone,
			market_scheduled_asset_price_next_send_at:
				updatedUser.market_scheduled_asset_price_next_send_at,
			daily_digest_next_send_at: updatedUser.daily_digest_next_send_at,
			asset_events_next_send_at: updatedUser.asset_events_next_send_at,
		},
	});
};
