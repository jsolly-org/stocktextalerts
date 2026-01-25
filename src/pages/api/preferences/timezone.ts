import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
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
		logger.error("Timezone update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return redirect("/signin?error=unauthorized");
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		timezone: { type: "timezone", required: true },
	} as const);

	if (!parsed.ok) {
		logger.error("Timezone update rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect("/dashboard?error=invalid_form");
	}

	try {
		await users.update(authUser.id, {
			timezone: parsed.data.timezone,
		});
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
		return redirect("/dashboard?error=update_failed");
	}

	return redirect("/dashboard?success=timezone_updated");
};
