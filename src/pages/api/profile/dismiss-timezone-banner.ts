import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../lib/client/types";
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
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
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
		return Response.json(
			{
				ok: false,
				message: "failed_to_dismiss_timezone_banner",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}

	return Response.json({ ok: true, message: "timezone_banner_dismissed" } satisfies ApiJsonBody, {
		status: 200,
	});
};
