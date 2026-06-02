import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";

const TIME_FORMAT_SCHEMA = {
	use_24_hour_time: { type: "boolean" },
} as const satisfies FormSchema;

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
		logger.info("Time-format update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch (error) {
		logger.info(
			"Time-format update rejected due to malformed request body",
			{
				userId: user.id,
				contentType: request.headers.get("content-type"),
			},
			error,
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	const parsed = parseWithSchema(formData, TIME_FORMAT_SCHEMA);

	if (!parsed.ok) {
		logger.info("Time-format update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	try {
		const updates: Record<string, boolean> = {};
		if (parsed.data.use_24_hour_time !== undefined) {
			updates.use_24_hour_time = parsed.data.use_24_hour_time;
		}

		if (Object.keys(updates).length === 0) {
			logger.info("Time-format update rejected due to empty update payload", {
				userId: user.id,
			});
			return jsonResponse(400, { ok: false, message: "invalid_form" });
		}

		const updatedUser = await userService.update(user.id, updates);
		if (!updatedUser) {
			logger.error("User update returned null", { userId: user.id });
			return jsonResponse(404, { ok: false, message: "user_not_found" });
		}

		return jsonResponse(200, {
			ok: true,
			message: "settings_updated",
			use_24_hour_time: updatedUser.use_24_hour_time,
		});
	} catch (error) {
		logger.error("Failed to update time-format", { userId: user.id }, createErrorForLogging(error));

		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_settings",
		});
	}
};
