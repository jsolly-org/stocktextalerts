import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService, type User } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";
import { calculateNextSendAtFromTimes } from "../../../lib/time/schedule";

export const POST: APIRoute = async ({ request, cookies, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);

	const authUser = await users.getCurrentUser();
	if (!authUser) {
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("Timezone update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		timezone: { type: "timezone", required: true },
	} as const);

	if (!parsed.ok) {
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("Timezone update rejected due to invalid form", {
			userId: authUser.id,
			errors: parsed.allErrors,
		});
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	let dbUser: User | null;
	try {
		dbUser = await users.getById(authUser.id);
	} catch (error) {
		const errorObject =
			error instanceof Error ? error : new Error(String(error));
		logger.error(
			"Failed to fetch user for timezone update",
			{ userId: authUser.id },
			errorObject,
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

	const timezoneChanged = parsed.data.timezone !== dbUser.timezone;
	const updatePayload: { timezone: string; next_send_at?: string | null } = {
		timezone: parsed.data.timezone,
	};
	if (timezoneChanged && dbUser.daily_digest_enabled) {
		if (
			!dbUser.daily_digest_notification_times ||
			dbUser.daily_digest_notification_times.length === 0
		) {
			updatePayload.next_send_at = null;
		} else {
			const nextSendAt = calculateNextSendAtFromTimes(
				dbUser.daily_digest_notification_times,
				parsed.data.timezone,
				DateTime.utc(),
			);
			if (nextSendAt) {
				const nextSendAtIso = nextSendAt.toISO();
				if (nextSendAtIso) {
					updatePayload.next_send_at = nextSendAtIso;
				} else {
					logger.warn(
						"Failed to convert next_send_at to ISO after timezone change",
						{
							userId: authUser.id,
							timezone: parsed.data.timezone,
							nextSendAt: nextSendAt.toString(),
							nextSendAtIsValid: nextSendAt.isValid,
							nextSendAtInvalidReason: nextSendAt.invalidReason,
						},
					);
					updatePayload.next_send_at = null;
				}
			} else {
				logger.warn("Failed to calculate next_send_at after timezone change", {
					userId: authUser.id,
					timezone: parsed.data.timezone,
				});
				updatePayload.next_send_at = null;
			}
		}
	}

	let updatedUser: User;
	try {
		updatedUser = await users.update(authUser.id, updatePayload);
	} catch (error) {
		const errorObject =
			error instanceof Error ? error : new Error(String(error));
		logger.error(
			"Failed to update timezone",
			{
				userId: authUser.id,
				timezone: parsed.data.timezone,
			},
			errorObject,
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
		preferences: {
			timezone: updatedUser.timezone,
			next_send_at: updatedUser.next_send_at,
		},
	});
};
