import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../lib/client/types";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../../../lib/constants";
import {
	hasAnyDailyNotificationFacet,
	isDailyNotificationFacetEnabled,
} from "../../../lib/daily-notification/eligibility";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import type { User } from "../../../lib/db/types";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";
import {
	buildChannelPreferenceSnapshot,
	loadUserPreferenceRows,
	persistChannelPreferences,
} from "../../../lib/notification-preferences/channels";
import { NOTIFICATION_PREFERENCES_SCHEMA } from "../../../lib/notification-preferences/constants";
import {
	buildNotificationPreferencesUpdatePayload,
	DAILY_NOTIFICATION_SCHEDULE_FIELDS,
} from "../../../lib/notification-preferences/update-payload";
import { userLocalToEtMinute } from "../../../lib/time/conversion";
import { isOutsideMarketHours } from "../../../lib/time/market/session";
import { parseScheduledTimes } from "../../../lib/time/schedule/next-send";

/**
 * Update the authenticated user's notification-preferences.
 *
 * Accepts a form POST, validates input, persists the update, and returns the
 * updated preference snapshot.
 */
export const POST: APIRoute = async ({ url, request, cookies, locals }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const userService = createUserService(supabase, cookies);

	const user = await userService.getCurrentUser();
	if (!user) {
		logger.info("Notification-preferences update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
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
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}
	const rawTimesValue = formData.get("market_scheduled_asset_price_times");
	const parsed = parseWithSchema(formData, NOTIFICATION_PREFERENCES_SCHEMA);

	if (!parsed.ok) {
		logger.info("Notification-preferences update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	let parsedMarketScheduledAssetPriceTimes: number[] | undefined;
	if (rawTimesValue !== "" && parsed.data.market_scheduled_asset_price_times !== undefined) {
		const result = parseScheduledTimes(parsed.data.market_scheduled_asset_price_times);
		if (!result.ok) {
			logger.info("Notification-preferences update rejected due to invalid scheduled times", {
				userId: user.id,
				reason: result.reason,
			});
			return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
				status: 400,
			});
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
		return Response.json(
			{
				ok: false,
				message: "failed_to_update_settings",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}
	if (!dbUser) {
		logger.info("User not found for notification-preferences update", {
			userId: user.id,
		});
		return Response.json({ ok: false, message: "user_not_found" } satisfies ApiJsonBody, {
			status: 404,
		});
	}

	// Validate scheduled times are within the extended-hours notification window (4:30 AM – 7:30 PM ET)
	if (parsedMarketScheduledAssetPriceTimes?.length) {
		const tz = (parsed.data.timezone as string | undefined) ?? dbUser.timezone;
		const invalidTime = parsedMarketScheduledAssetPriceTimes.find((m) =>
			isOutsideMarketHours(userLocalToEtMinute(m, tz)),
		);
		if (invalidTime !== undefined) {
			logger.info("Notification-preferences update rejected: scheduled time outside market hours", {
				userId: user.id,
				invalidTime,
				timezone: tz,
			});
			return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
				status: 400,
			});
		}
	}

	// Per-option channel facets live in notification_preferences. Load the user's
	// CURRENT rows so we can compute the post-update daily notification state (for
	// daily_notification_next_send_at).
	let existingPrefs: Awaited<ReturnType<typeof loadUserPreferenceRows>>;
	try {
		existingPrefs = await loadUserPreferenceRows(supabase, user.id);
	} catch (error) {
		logger.error("Failed to load existing notification preferences", { userId: user.id }, error);
		return Response.json(
			{ ok: false, message: "failed_to_update_settings" } satisfies ApiJsonBody,
			{ status: 500 },
		);
	}

	const dailyNotificationScheduleSubmitted = DAILY_NOTIFICATION_SCHEDULE_FIELDS.some((field) =>
		formData.has(field),
	);
	// A daily facet is enabled after this update when its submitted form value says
	// so, falling back to the existing row for unsubmitted options. Iterating the
	// catalog covers exactly the valid (content, channel) combos — the FK guarantees
	// existingPrefs holds nothing outside it.
	const dailyNotificationEnabledAfterUpdate = NOTIFICATION_PREFERENCE_CATALOG.filter(
		(entry) => entry.notification_type === "daily_notification",
	).some((entry) =>
		formData.has(entry.fieldName) && parsed.data[entry.fieldName] !== undefined
			? parsed.data[entry.fieldName] === true
			: // Daily entries always carry a non-"" content facet; the check narrows the type.
				entry.content !== "" &&
				isDailyNotificationFacetEnabled(existingPrefs, entry.channel, entry.content),
	);
	const dailyNotificationEnabledBefore = hasAnyDailyNotificationFacet(existingPrefs);
	const dailyNotificationOptionsChanged =
		dailyNotificationScheduleSubmitted &&
		dailyNotificationEnabledAfterUpdate !== dailyNotificationEnabledBefore;

	let safeNotificationPreferenceUpdates: ReturnType<
		typeof buildNotificationPreferencesUpdatePayload
	>;
	try {
		safeNotificationPreferenceUpdates = buildNotificationPreferencesUpdatePayload({
			parsedData: parsed.data,
			formData,
			rawTimesValue: rawTimesValue as string | null,
			parsedMarketScheduledAssetPriceTimes,
			dbUser,
			dailyNotificationEnabledAfterUpdate,
			dailyNotificationOptionsChanged,
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
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	try {
		// A facet-only submission carries no `users`-column changes, so the payload
		// can be empty. Skip the no-op `users` UPDATE (PostgREST returns 0 rows for an
		// empty update, which `.single()` rejects) and reuse the freshly-fetched row.
		const updatedUser =
			Object.keys(safeNotificationPreferenceUpdates).length === 0
				? dbUser
				: await userService.update(user.id, safeNotificationPreferenceUpdates);
		if (!updatedUser) {
			logger.error("User update returned null", { userId: user.id });
			return Response.json({ ok: false, message: "user_not_found" } satisfies ApiJsonBody, {
				status: 404,
			});
		}

		// Persist every submitted channel facet (email/telegram alike) to
		// notification_preferences — the single source of truth. The session-scoped
		// `supabase` client (authed in getCurrentUser) satisfies the per-user RLS.
		await persistChannelPreferences({
			supabase,
			userId: user.id,
			parsedData: parsed.data,
			formData,
			logger,
		});

		// Rebuild the per-option snapshot from the table (post-write) for the UI.
		const updatedPrefs = await loadUserPreferenceRows(supabase, user.id);

		return Response.json(
			{
				ok: true,
				message: "settings_updated",
				notificationPreferences: {
					market_scheduled_asset_price_enabled: updatedUser.market_scheduled_asset_price_enabled,
					email_notifications_enabled: updatedUser.email_notifications_enabled,
					timezone: updatedUser.timezone,
					market_scheduled_asset_price_times: updatedUser.market_scheduled_asset_price_times,
					daily_notification_time: updatedUser.daily_notification_time,
					daily_notification_next_send_at: updatedUser.daily_notification_next_send_at,
					market_scheduled_asset_price_next_send_at:
						updatedUser.market_scheduled_asset_price_next_send_at,
					dismiss_timezone_mismatch_prompts: updatedUser.dismiss_timezone_mismatch_prompts,
					...buildChannelPreferenceSnapshot(updatedPrefs),
				},
			} satisfies ApiJsonBody,
			{ status: 200 },
		);
	} catch (error) {
		logger.error(
			"Failed to update notification-preferences",
			{
				userId: user.id,
				notificationPreferences: safeNotificationPreferenceUpdates,
			},
			createErrorForLogging(error),
		);

		return Response.json(
			{
				ok: false,
				message: "failed_to_update_settings",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}
};
