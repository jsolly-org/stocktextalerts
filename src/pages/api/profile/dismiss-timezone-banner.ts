import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";

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
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("Timezone banner dismissal attempt without authenticated user", {
			event: "unauthorized_timezone_banner_dismissal",
			reason: "no_authenticated_user",
			path: url.pathname,
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	try {
		await users.update(authUser.id, {
			dismiss_timezone_mismatch_prompts: true,
		});
	} catch (error) {
		logger.error(
			"Failed to dismiss timezone banner",
			{ userId: authUser.id },
			createErrorForLogging(error),
		);
		return jsonResponse(500, {
			ok: false,
			message: "failed_to_dismiss_timezone_banner",
		});
	}

	return jsonResponse(200, { ok: true, message: "timezone_banner_dismissed" });
};
