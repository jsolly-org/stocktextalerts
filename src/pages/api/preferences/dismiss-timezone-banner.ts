import type { APIRoute } from "astro";
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
		logger.error(
			"Timezone banner dismissal attempt without authenticated user",
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
				{ ok: false, message: "update_failed" },
				{ status: 500 },
			);
		}
		return redirect("/dashboard?error=update_failed");
	}

	if (wantsJson) {
		return Response.json({ ok: true });
	}

	return redirect("/dashboard?success=timezone_banner_dismissed");
};
