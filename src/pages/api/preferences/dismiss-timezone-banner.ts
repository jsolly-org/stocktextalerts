import type { APIRoute } from "astro";
import { buildDashboardRedirect } from "../../../lib/constants";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";

export const POST: APIRoute = async ({
	request,
	cookies,
	redirect,
	locals,
}) => {
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
		logger.info(
			"Timezone banner dismissal attempt without authenticated user",
			{
				event: "unauthorized_timezone_banner_dismissal",
				reason: "no_authenticated_user",
				path: url.pathname,
			},
		);
		return redirect("/signin?error=unauthorized");
	}

	const wantsJson = request.headers
		.get("accept")
		?.toLowerCase()
		.includes("application/json");

	try {
		await users.update(authUser.id, {
			dismiss_timezone_mismatch_prompts: true,
		});
	} catch (error) {
		logger.error(
			"Failed to dismiss timezone banner",
			{
				userId: authUser.id,
			},
			error instanceof Error ? error : new Error(String(error)),
		);
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "failed_to_dismiss_timezone_banner" },
				{ status: 500 },
			);
		}
		return redirect(
			buildDashboardRedirect({
				error: "failed_to_dismiss_timezone_banner",
				section: "preferences",
			}),
		);
	}

	if (wantsJson) {
		return Response.json({ ok: true });
	}

	return redirect(
		buildDashboardRedirect({
			success: "timezone_banner_dismissed",
			section: "preferences",
		}),
	);
};
